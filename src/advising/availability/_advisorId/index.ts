/**
 * GET /advising/availability/advisor/{advisorId}
 * Scope: com.apigw/advising.student
 *
 * Returns AVAILABLE slots for the given advisor in the next 2 weeks.
 */
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const SLOTS_TABLE = process.env.ADVISING_SLOTS_TABLE!;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  const advisorId = event.pathParameters?.advisorId;
  if (!advisorId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Missing advisorId path parameter' }),
    };
  }

  const now = new Date();
  const twoWeeksOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: SLOTS_TABLE,
        IndexName: 'advisorId-slotDateTime-index',
        KeyConditionExpression:
          'advisorId = :advisorId AND slotDateTime BETWEEN :now AND :twoWeeksOut',
        FilterExpression: '#st = :available',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':advisorId': advisorId,
          ':now': now.toISOString(),
          ':twoWeeksOut': twoWeeksOut.toISOString(),
          ':available': 'AVAILABLE',
        },
      }),
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ data: result.Items ?? [] }),
    };
  } catch (err) {
    console.error('Error querying slots:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }
};
