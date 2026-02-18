/**
 * GET /advising/admin/config  — read global advising config
 * PUT /advising/admin/config  — update global advising config (pause/unpause)
 * Scope: com.apigw/advising.admin
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
import * as z from 'zod';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const CONFIG_TABLE = process.env.ADVISING_CONFIG_TABLE!;
const CONFIG_KEY = 'ADVISING_PAUSED';

const UpdateConfigRequest = z.object({
  value: z.boolean(),
  reason: z.string().optional(),
});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  const adminSub =
    event.requestContext?.authorizer?.claims?.sub as string | undefined;

  switch (event.httpMethod) {
    case 'GET':
      return getConfig();
    case 'PUT':
      return updateConfig(event.body, adminSub);
    default:
      return { statusCode: 405, body: JSON.stringify({ message: 'Method not allowed' }) };
  }
};

async function getConfig(): Promise<APIGatewayProxyResult> {
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: CONFIG_TABLE, Key: { configKey: CONFIG_KEY } }),
    );

    // Return a sensible default if the item doesn't exist yet
    if (!result.Item) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          configKey: CONFIG_KEY,
          value: false,
          reason: '',
        }),
      };
    }

    return { statusCode: 200, body: JSON.stringify(result.Item) };
  } catch (err) {
    console.error('Error fetching config:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }
}

async function updateConfig(
  rawBody: string | null,
  updatedBy: string | undefined,
): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return { statusCode: 400, body: JSON.stringify({ message: 'Request body required' }) };
  }

  let body: z.infer<typeof UpdateConfigRequest>;
  try {
    body = UpdateConfigRequest.parse(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { statusCode: 400, body: JSON.stringify({ error: z.treeifyError(err) }) };
    }
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON' }) };
  }

  const now = new Date().toISOString();

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: CONFIG_TABLE,
        Key: { configKey: CONFIG_KEY },
        UpdateExpression:
          'SET #val = :val, reason = :reason, updatedAt = :ua, updatedBy = :ub',
        ExpressionAttributeNames: { '#val': 'value' },
        ExpressionAttributeValues: {
          ':val': body.value,
          ':reason': body.reason ?? '',
          ':ua': now,
          ':ub': updatedBy ?? 'unknown',
        },
      }),
    );
  } catch (err) {
    console.error('Error updating config:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: `Advising ${body.value ? 'paused' : 'unpaused'}`,
      configKey: CONFIG_KEY,
      value: body.value,
    }),
  };
}
