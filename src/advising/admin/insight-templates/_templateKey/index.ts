/**
 * GET    /advising/admin/insight-templates/{templateKey}  — read an insight SQL template
 * PUT    /advising/admin/insight-templates/{templateKey}  — update an insight SQL template
 * DELETE /advising/admin/insight-templates/{templateKey}  — delete an insight SQL template
 * Scope: com.apigw/advising.admin
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import * as z from 'zod';
import {
  errorResponse,
  validationErrorResponse,
} from '../../../../lib/serverResponseBuilder';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const INSIGHT_TEMPLATES_TABLE = process.env.ADVISING_INSIGHT_TEMPLATES_TABLE!;

const UpdateInsightTemplateRequest = z.object({
  sql: z.string().trim().min(1),
});

function validateTemplateSql(sql: string): string | null {
  if (!/:student_id\b/.test(sql)) {
    return 'SQL must include :student_id parameter';
  }
  return null;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  const templateKey = event.pathParameters?.templateKey;
  if (!templateKey) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      'Missing templateKey path parameter',
    );
  }

  switch (event.httpMethod) {
    case 'GET':
      return getTemplate(templateKey);
    case 'PUT':
      return updateTemplate(templateKey, event.body);
    case 'DELETE':
      return deleteTemplate(templateKey);
    default:
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
};

async function getTemplate(templateKey: string): Promise<APIGatewayProxyResult> {
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: INSIGHT_TEMPLATES_TABLE, Key: { templateKey } }),
    );
    if (!result.Item) {
      return errorResponse(404, 'RESOURCE_NOT_FOUND', 'Template not found');
    }
    return { statusCode: 200, body: JSON.stringify(result.Item) };
  } catch (err) {
    console.error('Error fetching insight template:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }
}

async function updateTemplate(
  templateKey: string,
  rawBody: string | null,
): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return errorResponse(400, 'BAD_REQUEST', 'Request body required');
  }

  let body: z.infer<typeof UpdateInsightTemplateRequest>;
  try {
    body = UpdateInsightTemplateRequest.parse(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return validationErrorResponse(err);
    }
    return errorResponse(400, 'BAD_REQUEST', 'Invalid JSON');
  }

  const sqlError = validateTemplateSql(body.sql);
  if (sqlError) {
    return errorResponse(400, 'BAD_REQUEST', sqlError);
  }

  try {
    const existing = await ddb.send(
      new GetCommand({ TableName: INSIGHT_TEMPLATES_TABLE, Key: { templateKey } }),
    );
    if (!existing.Item) {
      return errorResponse(404, 'RESOURCE_NOT_FOUND', 'Template not found');
    }

    await ddb.send(
      new UpdateCommand({
        TableName: INSIGHT_TEMPLATES_TABLE,
        Key: { templateKey },
        UpdateExpression: 'SET sql = :sql, updatedAt = :ua',
        ExpressionAttributeValues: {
          ':sql': body.sql,
          ':ua': new Date().toISOString(),
        },
      }),
    );
  } catch (err) {
    console.error('Error updating insight template:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Template updated', templateKey }),
  };
}

async function deleteTemplate(
  templateKey: string,
): Promise<APIGatewayProxyResult> {
  try {
    const existing = await ddb.send(
      new GetCommand({ TableName: INSIGHT_TEMPLATES_TABLE, Key: { templateKey } }),
    );
    if (!existing.Item) {
      return errorResponse(404, 'RESOURCE_NOT_FOUND', 'Template not found');
    }

    await ddb.send(
      new DeleteCommand({ TableName: INSIGHT_TEMPLATES_TABLE, Key: { templateKey } }),
    );
  } catch (err) {
    console.error('Error deleting insight template:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Template deleted', templateKey }),
  };
}
