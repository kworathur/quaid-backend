/**
 * PUT /advising/availability/week/{weekStartDate}
 * Scope: com.apigw/advising.advisor
 *
 * Bulk-creates or replaces advisor availability slots for a given week.
 * weekStartDate must be an ISO-8601 date (YYYY-MM-DD) representing Monday.
 * Body: { slots: [{ slotDateTime: string, advisorDisplayName?: string }] }
 */
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import * as z from 'zod';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const SLOTS_TABLE = process.env.ADVISING_SLOTS_TABLE!;

const RequestBody = z.object({
  slots: z.array(
    z.object({
      slotDateTime: z.string(), // ISO-8601 UTC
      advisorDisplayName: z.string().optional(),
    }),
  ).min(1),
});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  if (event.httpMethod !== 'PUT') {
    return { statusCode: 405, body: JSON.stringify({ message: 'Method not allowed' }) };
  }

  const advisorId =
    event.requestContext?.authorizer?.claims?.sub as string | undefined;
  if (!advisorId) {
    return { statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) };
  }

  const weekStartDate = event.pathParameters?.weekStartDate;
  if (!weekStartDate) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Missing weekStartDate path parameter' }),
    };
  }

  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ message: 'Request body required' }) };
  }

  let body: z.infer<typeof RequestBody>;
  try {
    body = RequestBody.parse(JSON.parse(event.body));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: z.treeifyError(err) }),
      };
    }
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON' }) };
  }

  // Derive week boundaries (Mon 00:00 UTC → Sun 23:59:59 UTC)
  const weekStart = new Date(`${weekStartDate}T00:00:00Z`);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);

  if (isNaN(weekStart.getTime())) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'weekStartDate must be a valid ISO-8601 date (YYYY-MM-DD)' }),
    };
  }

  // Cancel any existing AVAILABLE slots the advisor has for this week so the
  // PUT is effectively a replace operation.
  try {
    const existing = await ddb.send(
      new QueryCommand({
        TableName: SLOTS_TABLE,
        IndexName: 'advisorId-slotDateTime-index',
        KeyConditionExpression:
          'advisorId = :aid AND slotDateTime BETWEEN :ws AND :we',
        FilterExpression: '#st = :available',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':aid': advisorId,
          ':ws': weekStart.toISOString(),
          ':we': weekEnd.toISOString(),
          ':available': 'AVAILABLE',
        },
      }),
    );

    for (const item of existing.Items ?? []) {
      await ddb.send(
        new UpdateCommand({
          TableName: SLOTS_TABLE,
          Key: { slotId: item.slotId },
          UpdateExpression: 'SET #st = :cancelled',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':cancelled': 'CANCELLED' },
        }),
      );
    }
  } catch (err) {
    console.error('Error cancelling existing slots:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }

  // Create the new slots
  const now = new Date().toISOString();
  const created: string[] = [];
  try {
    for (const slot of body.slots) {
      const slotId = uuidv4();
      await ddb.send(
        new PutCommand({
          TableName: SLOTS_TABLE,
          Item: {
            slotId,
            advisorId,
            slotDateTime: slot.slotDateTime,
            status: 'AVAILABLE',
            advisorCreatedAt: now,
            ...(slot.advisorDisplayName
              ? { advisorDisplayName: slot.advisorDisplayName }
              : {}),
          },
        }),
      );
      created.push(slotId);
    }
  } catch (err) {
    console.error('Error creating slots:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Availability updated', slotIds: created }),
  };
};
