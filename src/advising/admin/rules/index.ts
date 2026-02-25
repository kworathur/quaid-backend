/**
 * POST /advising/admin/rules  — create an assignment rule
 * GET  /advising/admin/rules  — list all assignment rules
 * Scope: com.apigw/advising.admin
 */
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import * as z from 'zod';
import { ConditionType } from '../../../lib/types/advising';

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
      return listRules();
    case 'POST':
      return createRule(event.body);
    default:
      return { statusCode: 405, body: JSON.stringify({ message: 'Method not allowed' }) };
  }
};

async function createRule(rawBody: string | null): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return { statusCode: 400, body: JSON.stringify({ message: 'Request body required' }) };
  }

  let body: z.infer<typeof CreateRuleRequest>;
  try {
    body = CreateRuleRequest.parse(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { statusCode: 400, body: JSON.stringify({ error: z.treeifyError(err) }) };
    }
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON' }) };
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
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }

  return { statusCode: 201, body: JSON.stringify({ message: 'Rule created', ruleId }) };
}

async function listRules(): Promise<APIGatewayProxyResult> {
  try {
    const result = await ddb.send(new ScanCommand({ TableName: RULES_TABLE }));
    const rules = (result.Items ?? []).sort(
      (a, b) => (a.priority as number) - (b.priority as number),
    );
    return { statusCode: 200, body: JSON.stringify({ data: rules }) };
  } catch (err) {
    console.error('Error listing rules:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }
}
