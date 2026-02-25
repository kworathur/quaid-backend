/**
 * GET /advising/admin/config  — read global advising config
 * PUT /advising/admin/config  — update global advising config (pause/unpause)
 * Scope: com.apigw/advising.admin
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import * as z from 'zod';
import {
  errorResponse,
  validationErrorResponse,
} from '../../../lib/serverResponseBuilder';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const CONFIG_TABLE = process.env.ADVISING_CONFIG_TABLE!;

// Allowed config keys that admins may read/update via this endpoint.
// ADVISING_PAUSED: when true, all student booking attempts return 503.
const ALLOWED_CONFIG_KEYS = ['ADVISING_PAUSED'] as const;
const ConfigKey = z.enum(ALLOWED_CONFIG_KEYS);

const UpdateConfigRequest = z.object({
  configKey: ConfigKey,
  value: z.boolean(),
  reason: z.string().optional(),
});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  const adminSub = event.requestContext?.authorizer?.claims?.sub as
    | string
    | undefined;

  switch (event.httpMethod) {
    case 'GET':
      return getConfig(event.queryStringParameters?.configKey);
    case 'PUT':
      return updateConfig(event.body, adminSub);
    default:
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
};

async function getConfig(
  rawConfigKey: string | undefined,
): Promise<APIGatewayProxyResult> {
  // Default to ADVISING_PAUSED when no query param is provided
  const configKey = rawConfigKey ?? 'ADVISING_PAUSED';
  const parsed = ConfigKey.safeParse(configKey);
  if (!parsed.success) {
    return errorResponse(400, 'BAD_REQUEST', `Unknown configKey: ${configKey}`);
  }

  try {
    const result = await ddb.send(
      new GetCommand({ TableName: CONFIG_TABLE, Key: { configKey } }),
    );

    // Return a sensible default if the item doesn't exist yet
    if (!result.Item) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          configKey,
          value: false,
          reason: '',
        }),
      };
    }

    return { statusCode: 200, body: JSON.stringify(result.Item) };
  } catch (err) {
    console.error('Error fetching config:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }
}

async function updateConfig(
  rawBody: string | null,
  updatedBy: string | undefined,
): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return errorResponse(400, 'BAD_REQUEST', 'Request body required');
  }

  let body: z.infer<typeof UpdateConfigRequest>;
  try {
    body = UpdateConfigRequest.parse(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return validationErrorResponse(err);
    }
    return errorResponse(400, 'BAD_REQUEST', 'Invalid JSON');
  }

  const now = new Date().toISOString();
  const configKey = body.configKey;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: CONFIG_TABLE,
        Key: { configKey },
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
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  const label =
    configKey === 'ADVISING_PAUSED'
      ? `Advising ${body.value ? 'paused' : 'unpaused'}`
      : `${configKey} updated`;

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: label,
      configKey,
      value: body.value,
    }),
  };
}
