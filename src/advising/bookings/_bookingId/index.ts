/**
 * DELETE /advising/bookings/{bookingId}
 * Scope: com.apigw/advising.student
 *
 * Cancels a booking: sets status = CANCELLED and clears studentId so GSI2
 * stops indexing it.
 */
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const SLOTS_TABLE = process.env.ADVISING_SLOTS_TABLE!;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  if (event.httpMethod !== 'DELETE') {
    return { statusCode: 405, body: JSON.stringify({ message: 'Method not allowed' }) };
  }

  const studentIdClaim =
    event.requestContext?.authorizer?.claims?.['custom:studentId'];
  if (!studentIdClaim) {
    return { statusCode: 400, body: JSON.stringify({ message: 'Missing custom:studentId claim' }) };
  }
  const studentId = parseInt(studentIdClaim, 10);

  const bookingId = event.pathParameters?.bookingId;
  if (!bookingId) {
    return { statusCode: 400, body: JSON.stringify({ message: 'Missing bookingId path parameter' }) };
  }

  // Verify the slot exists and belongs to this student
  let slot: Record<string, unknown>;
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: SLOTS_TABLE, Key: { slotId: bookingId } }),
    );
    if (!result.Item) {
      return { statusCode: 404, body: JSON.stringify({ message: 'Booking not found' }) };
    }
    slot = result.Item as Record<string, unknown>;
  } catch (err) {
    console.error('Error fetching slot:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }

  if (slot.studentId !== studentId) {
    return { statusCode: 403, body: JSON.stringify({ message: 'Forbidden' }) };
  }

  if (slot.status !== 'BOOKED') {
    return {
      statusCode: 409,
      body: JSON.stringify({ message: `Cannot cancel a slot with status ${slot.status}` }),
    };
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: SLOTS_TABLE,
        Key: { slotId: bookingId },
        UpdateExpression:
          'SET #st = :cancelled REMOVE studentId, bookingDescription, bookingCreatedAt',
        ConditionExpression: '#st = :booked AND studentId = :sid',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':cancelled': 'CANCELLED',
          ':booked': 'BOOKED',
          ':sid': studentId,
        },
      }),
    );
  } catch (err: unknown) {
    const errName = (err as { name?: string }).name;
    if (errName === 'ConditionalCheckFailedException') {
      return {
        statusCode: 409,
        body: JSON.stringify({ message: 'Booking could not be cancelled (concurrent modification)' }),
      };
    }
    console.error('Error cancelling booking:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Booking cancelled', slotId: bookingId }),
  };
};
