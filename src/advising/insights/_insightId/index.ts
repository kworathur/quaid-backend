/**
 * GET    /advising/insights/{insightId}  — read an insight
 * PUT    /advising/insights/{insightId}  — update an insight
 * DELETE /advising/insights/{insightId}  — delete an insight
 * Scope: com.apigw/advising.advisor
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import * as z from 'zod';
import { TemplateKey } from '../../../lib/types/advising';
import { INSIGHT_TEMPLATES } from '../../../lib/advisingInsightTemplates';
import {
  errorResponse,
  validationErrorResponse,
} from '../../../lib/serverResponseBuilder';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const INSIGHTS_TABLE = process.env.ADVISING_INSIGHTS_TABLE!;

const UpdateInsightRequest = z.object({
  name: z.string().min(1).optional(),
  templateKey: TemplateKey.optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  const advisorId = event.requestContext?.authorizer?.claims?.sub as
    | string
    | undefined;
  if (!advisorId) {
    return errorResponse(401, 'UNAUTHORIZED', 'Unauthorized');
  }

  const insightId = event.pathParameters?.insightId;
  if (!insightId) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      'Missing insightId path parameter',
    );
  }

  switch (event.httpMethod) {
    case 'GET':
      return getInsight(advisorId, insightId);
    case 'PUT':
      return updateInsight(advisorId, insightId, event.body);
    case 'DELETE':
      return deleteInsight(advisorId, insightId);
    default:
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
};

async function fetchAndAuthorize(
  advisorId: string,
  insightId: string,
): Promise<{ item: Record<string, unknown> } | APIGatewayProxyResult> {
  const result = await ddb.send(
    new GetCommand({ TableName: INSIGHTS_TABLE, Key: { insightId } }),
  );
  if (!result.Item) {
    return errorResponse(404, 'RESOURCE_NOT_FOUND', 'Insight not found');
  }
  if (result.Item.advisorId !== advisorId) {
    return errorResponse(403, 'FORBIDDEN', 'Forbidden');
  }
  return { item: result.Item as Record<string, unknown> };
}

function isApiResult(v: unknown): v is APIGatewayProxyResult {
  return (
    typeof v === 'object' && v !== null && 'statusCode' in v && 'body' in v
  );
}

async function getInsight(
  advisorId: string,
  insightId: string,
): Promise<APIGatewayProxyResult> {
  try {
    const res = await fetchAndAuthorize(advisorId, insightId);
    if (isApiResult(res)) return res;
    return { statusCode: 200, body: JSON.stringify(res.item) };
  } catch (err) {
    console.error('Error fetching insight:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }
}

async function updateInsight(
  advisorId: string,
  insightId: string,
  rawBody: string | null,
): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return errorResponse(400, 'BAD_REQUEST', 'Request body required');
  }

  let body: z.infer<typeof UpdateInsightRequest>;
  try {
    body = UpdateInsightRequest.parse(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return validationErrorResponse(err);
    }
    return errorResponse(400, 'BAD_REQUEST', 'Invalid JSON');
  }

  try {
    const authRes = await fetchAndAuthorize(advisorId, insightId);
    if (isApiResult(authRes)) return authRes;

    const existingItem = authRes.item;
    const effectiveTemplateKey =
      body.templateKey ?? (existingItem.templateKey as string);
    const effectiveParams =
      body.parameters ?? (existingItem.parameters as Record<string, unknown>);

    // Validate parameters against template
    const template =
      INSIGHT_TEMPLATES[effectiveTemplateKey as keyof typeof INSIGHT_TEMPLATES];
    const paramValidation = template.paramSchema.safeParse(effectiveParams);
    if (!paramValidation.success) {
      return errorResponse(
        400,
        'BAD_REQUEST',
        'Invalid parameters for template',
        z.treeifyError(paramValidation.error),
      );
    }

    const updateParts: string[] = ['updatedAt = :ua'];
    const eav: Record<string, unknown> = { ':ua': new Date().toISOString() };
    if (body.name !== undefined) {
      updateParts.push('#nm = :nm');
      eav[':nm'] = body.name;
    }
    if (body.templateKey !== undefined) {
      updateParts.push('templateKey = :tk');
      eav[':tk'] = body.templateKey;
    }
    if (body.parameters !== undefined) {
      updateParts.push('parameters = :p');
      eav[':p'] = body.parameters;
    }

    await ddb.send(
      new UpdateCommand({
        TableName: INSIGHTS_TABLE,
        Key: { insightId },
        UpdateExpression: `SET ${updateParts.join(', ')}`,
        ExpressionAttributeNames:
          body.name !== undefined ? { '#nm': 'name' } : undefined,
        ExpressionAttributeValues: eav,
      }),
    );
  } catch (err) {
    console.error('Error updating insight:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Insight updated', insightId }),
  };
}

async function deleteInsight(
  advisorId: string,
  insightId: string,
): Promise<APIGatewayProxyResult> {
  try {
    const authRes = await fetchAndAuthorize(advisorId, insightId);
    if (isApiResult(authRes)) return authRes;

    await ddb.send(
      new DeleteCommand({ TableName: INSIGHTS_TABLE, Key: { insightId } }),
    );
  } catch (err) {
    console.error('Error deleting insight:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Insight deleted', insightId }),
  };
}
