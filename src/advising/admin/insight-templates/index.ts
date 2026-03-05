/**
 * POST /advising/admin/insight-templates  — create/update an insight SQL template
 * GET  /advising/admin/insight-templates  — list all insight SQL templates
 * Scope: com.apigw/advising.admin
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import * as z from 'zod';
import {
  errorResponse,
  validationErrorResponse,
} from '../../../lib/serverResponseBuilder';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const INSIGHT_TEMPLATES_TABLE = process.env.ADVISING_INSIGHT_TEMPLATES_TABLE!;

const CreateInsightTemplateRequest = z.object({
  templateKey: z.string().trim().min(1),
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

  switch (event.httpMethod) {
    case 'GET':
      return listTemplates(event.queryStringParameters);
    case 'POST':
      return createOrUpdateTemplate(event.body);
    default:
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
};

async function createOrUpdateTemplate(
  rawBody: string | null,
): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return errorResponse(400, 'BAD_REQUEST', 'Request body required');
  }

  let body: z.infer<typeof CreateInsightTemplateRequest>;
  try {
    body = CreateInsightTemplateRequest.parse(JSON.parse(rawBody));
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

  const now = new Date().toISOString();

  try {
    await ddb.send(
      new PutCommand({
        TableName: INSIGHT_TEMPLATES_TABLE,
        Item: {
          templateKey: body.templateKey,
          sql: body.sql,
          updatedAt: now,
        },
      }),
    );
  } catch (err) {
    console.error('Error creating/updating insight template:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 201,
    body: JSON.stringify({
      message: 'Insight template stored',
      templateKey: body.templateKey,
    }),
  };
}

const DEFAULT_PAGE_LIMIT = 25;

async function listTemplates(
  queryParams: Record<string, string | undefined> | null,
): Promise<APIGatewayProxyResult> {
  const limit = Math.min(
    parseInt(queryParams?.limit ?? String(DEFAULT_PAGE_LIMIT), 10) ||
      DEFAULT_PAGE_LIMIT,
    100,
  );
  const lastKey = queryParams?.lastKey;

  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: INSIGHT_TEMPLATES_TABLE,
        Limit: limit,
        ...(lastKey ? { ExclusiveStartKey: { templateKey: lastKey } } : {}),
      }),
    );

    const response: Record<string, unknown> = { data: result.Items ?? [] };
    if (result.LastEvaluatedKey) {
      response.lastKey = result.LastEvaluatedKey.templateKey;
    }

    return { statusCode: 200, body: JSON.stringify(response) };
  } catch (err) {
    console.error('Error listing insight templates:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }
}
