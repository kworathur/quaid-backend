/**
 * GET /advising/sessions
 * Scope: com.apigw/advising.advisor
 *
 * Returns all BOOKED sessions for the authenticated advisor in the current
 * and upcoming week.
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

  const advisorId =
    event.requestContext?.authorizer?.claims?.sub as string | undefined;
  if (!advisorId) {
    return { statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) };
  }

  // Current week Monday 00:00 UTC through two weeks ahead
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0 = Sun
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(now.getTime() - daysToMonday * 24 * 60 * 60 * 1000);
  weekStart.setUTCHours(0, 0, 0, 0);
  const twoWeeksEnd = new Date(weekStart.getTime() + 14 * 24 * 60 * 60 * 1000 - 1);

  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: SLOTS_TABLE,
        IndexName: 'advisorId-slotDateTime-index',
        KeyConditionExpression:
          'advisorId = :aid AND slotDateTime BETWEEN :ws AND :we',
        FilterExpression: '#st = :booked',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':aid': advisorId,
          ':ws': weekStart.toISOString(),
          ':we': twoWeeksEnd.toISOString(),
          ':booked': 'BOOKED',
        },
      }),
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ data: result.Items ?? [] }),
    };
  } catch (err) {
    console.error('Error querying sessions:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }
};
