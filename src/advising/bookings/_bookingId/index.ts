/**
 * DELETE /advising/bookings/{bookingId}
 * Scope: com.apigw/advising.student
 *
 * Cancels a booking: sets status = CANCELLED and clears studentId so GSI2
 * stops indexing it.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { errorResponse } from '../../../lib/serverResponseBuilder';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const SLOTS_TABLE = process.env.ADVISING_SLOTS_TABLE!;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  if (event.httpMethod !== 'DELETE') {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }

  const studentIdClaim =
    event.requestContext?.authorizer?.claims?.['custom:studentId'];
  if (!studentIdClaim) {
    return errorResponse(400, 'BAD_REQUEST', 'Missing custom:studentId claim');
  }
  const studentId = parseInt(studentIdClaim, 10);

  const bookingId = event.pathParameters?.bookingId;
  if (!bookingId) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      'Missing bookingId path parameter',
    );
  }

  // Verify the slot exists and belongs to this student
  let slot: Record<string, unknown>;
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: SLOTS_TABLE, Key: { slotId: bookingId } }),
    );
    if (!result.Item) {
      return errorResponse(404, 'RESOURCE_NOT_FOUND', 'Booking not found');
    }
    slot = result.Item as Record<string, unknown>;
  } catch (err) {
    console.error('Error fetching slot:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  if (slot.studentId !== studentId) {
    return errorResponse(403, 'FORBIDDEN', 'Forbidden');
  }

  if (slot.status !== 'BOOKED') {
    return errorResponse(
      409,
      'CONFLICT',
      `Cannot cancel a slot with status ${slot.status}`,
    );
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
      return errorResponse(
        409,
        'CONFLICT',
        'Booking could not be cancelled (concurrent modification)',
      );
    }
    console.error('Error cancelling booking:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Booking cancelled', slotId: bookingId }),
  };
};
