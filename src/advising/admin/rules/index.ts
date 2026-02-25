/**
 * POST /advising/admin/rules  — create an assignment rule
 * GET  /advising/admin/rules  — list all assignment rules
 * Scope: com.apigw/advising.admin
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import * as z from 'zod';
import { ConditionType } from '../../../lib/types/advising';
import {
  errorResponse,
  validationErrorResponse,
} from '../../../lib/serverResponseBuilder';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const RULES_TABLE = process.env.ADVISING_RULES_TABLE!;

const CreateRuleRequest = z.object({
  advisorId: z.string().min(1),
  conditionType: ConditionType,
  parameters: z.record(z.string(), z.unknown()),
  priority: z.number().int().min(0),
  isActive: z.boolean().default(true),
});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  switch (event.httpMethod) {
    case 'GET':
      return listRules(event.queryStringParameters);
    case 'POST':
      return createRule(event.body);
    default:
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
};

async function createRule(
  rawBody: string | null,
): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return errorResponse(400, 'BAD_REQUEST', 'Request body required');
  }

  let body: z.infer<typeof CreateRuleRequest>;
  try {
    body = CreateRuleRequest.parse(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return validationErrorResponse(err);
    }
    return errorResponse(400, 'BAD_REQUEST', 'Invalid JSON');
  }

  const ruleId = uuidv4();
  const item = {
    ruleId,
    advisorId: body.advisorId,
    conditionType: body.conditionType,
    parameters: body.parameters,
    priority: body.priority,
    isActive: body.isActive,
    createdAt: new Date().toISOString(),
  };

  try {
    await ddb.send(new PutCommand({ TableName: RULES_TABLE, Item: item }));
  } catch (err) {
    console.error('Error creating rule:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 201,
    body: JSON.stringify({ message: 'Rule created', ruleId }),
  };
}

const DEFAULT_PAGE_LIMIT = 25;

async function listRules(
  queryParams: Record<string, string | undefined> | null,
): Promise<APIGatewayProxyResult> {
  const limit = Math.min(
    parseInt(queryParams?.limit ?? String(DEFAULT_PAGE_LIMIT), 10) ||
      DEFAULT_PAGE_LIMIT,
    100,
  );
  const lastKey = queryParams?.lastKey; // ruleId cursor from previous page

  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: RULES_TABLE,
        Limit: limit,
        ...(lastKey ? { ExclusiveStartKey: { ruleId: lastKey } } : {}),
      }),
    );

    const rules = (result.Items ?? []).sort(
      (a, b) => (a.priority as number) - (b.priority as number),
    );

    const response: Record<string, unknown> = { data: rules };
    if (result.LastEvaluatedKey) {
      response.lastKey = result.LastEvaluatedKey.ruleId;
    }

    return { statusCode: 200, body: JSON.stringify(response) };
  } catch (err) {
    console.error('Error listing rules:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }
}
