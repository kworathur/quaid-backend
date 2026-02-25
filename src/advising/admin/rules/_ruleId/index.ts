/**
 * PUT    /advising/admin/rules/{ruleId}  — update a rule
 * DELETE /advising/admin/rules/{ruleId}  — delete a rule
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
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import * as z from 'zod';
import { ConditionType } from '../../../../lib/types/advising';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const RULES_TABLE = process.env.ADVISING_RULES_TABLE!;

const UpdateRuleRequest = z.object({
  conditionType: ConditionType.optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  const ruleId = event.pathParameters?.ruleId;
  if (!ruleId) {
    return { statusCode: 400, body: JSON.stringify({ message: 'Missing ruleId path parameter' }) };
  }

  switch (event.httpMethod) {
    case 'PUT':
      return updateRule(ruleId, event.body);
    case 'DELETE':
      return deleteRule(ruleId);
    default:
      return { statusCode: 405, body: JSON.stringify({ message: 'Method not allowed' }) };
  }
};

async function updateRule(
  ruleId: string,
  rawBody: string | null,
): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return { statusCode: 400, body: JSON.stringify({ message: 'Request body required' }) };
  }

  let body: z.infer<typeof UpdateRuleRequest>;
  try {
    body = UpdateRuleRequest.parse(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { statusCode: 400, body: JSON.stringify({ error: z.treeifyError(err) }) };
    }
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON' }) };
  }

  // Verify rule exists
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: RULES_TABLE, Key: { ruleId } }),
    );
    if (!result.Item) {
      return { statusCode: 404, body: JSON.stringify({ message: 'Rule not found' }) };
    }
  } catch (err) {
    console.error('Error fetching rule:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }

  const updateParts: string[] = [];
  const ean: Record<string, string> = {};
  const eav: Record<string, unknown> = {};

  if (body.conditionType !== undefined) {
    updateParts.push('conditionType = :ct');
    eav[':ct'] = body.conditionType;
  }
  if (body.parameters !== undefined) {
    updateParts.push('parameters = :p');
    eav[':p'] = body.parameters;
  }
  if (body.priority !== undefined) {
    updateParts.push('#pri = :pri');
    ean['#pri'] = 'priority';
    eav[':pri'] = body.priority;
  }
  if (body.isActive !== undefined) {
    updateParts.push('isActive = :ia');
    eav[':ia'] = body.isActive;
  }

  if (updateParts.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ message: 'No fields to update' }) };
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: RULES_TABLE,
        Key: { ruleId },
        UpdateExpression: `SET ${updateParts.join(', ')}`,
        ExpressionAttributeNames: Object.keys(ean).length > 0 ? ean : undefined,
        ExpressionAttributeValues: eav,
      }),
    );
  } catch (err) {
    console.error('Error updating rule:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ message: 'Rule updated', ruleId }) };
}

async function deleteRule(ruleId: string): Promise<APIGatewayProxyResult> {
  try {
    // Verify exists before deleting
    const result = await ddb.send(
      new GetCommand({ TableName: RULES_TABLE, Key: { ruleId } }),
    );
    if (!result.Item) {
      return { statusCode: 404, body: JSON.stringify({ message: 'Rule not found' }) };
    }

    await ddb.send(new DeleteCommand({ TableName: RULES_TABLE, Key: { ruleId } }));
  } catch (err) {
    console.error('Error deleting rule:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ message: 'Rule deleted', ruleId }) };
}
