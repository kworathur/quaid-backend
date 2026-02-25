/**
 * POST /advising/insights  — create an insight
 * GET  /advising/insights  — list advisor's insights
 * Scope: com.apigw/advising.advisor
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import * as z from 'zod';
import { TemplateKey } from '../../lib/types/advising';
import { INSIGHT_TEMPLATES } from '../../lib/advisingInsightTemplates';
import {
  errorResponse,
  validationErrorResponse,
} from '../../lib/serverResponseBuilder';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const INSIGHTS_TABLE = process.env.ADVISING_INSIGHTS_TABLE!;

const CreateInsightRequest = z.object({
  name: z.string().min(1),
  templateKey: TemplateKey,
  parameters: z.record(z.string(), z.unknown()),
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

  switch (event.httpMethod) {
    case 'GET':
      return listInsights(advisorId);
    case 'POST':
      return createInsight(advisorId, event.body);
    default:
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
};

async function createInsight(
  advisorId: string,
  rawBody: string | null,
): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return errorResponse(400, 'BAD_REQUEST', 'Request body required');
  }

  let body: z.infer<typeof CreateInsightRequest>;
  try {
    body = CreateInsightRequest.parse(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return validationErrorResponse(err);
    }
    return errorResponse(400, 'BAD_REQUEST', 'Invalid JSON');
  }

  // Validate parameters against the template's schema
  const template = INSIGHT_TEMPLATES[body.templateKey];
  const paramValidation = template.paramSchema.safeParse(body.parameters);
  if (!paramValidation.success) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      'Invalid parameters for template',
      z.treeifyError(paramValidation.error),
    );
  }

  const now = new Date().toISOString();
  const insightId = uuidv4();
  const item = {
    insightId,
    advisorId,
    name: body.name,
    templateKey: body.templateKey,
    parameters: body.parameters,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await ddb.send(new PutCommand({ TableName: INSIGHTS_TABLE, Item: item }));
  } catch (err) {
    console.error('Error creating insight:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 201,
    body: JSON.stringify({ message: 'Insight created', insightId }),
  };
}

async function listInsights(advisorId: string): Promise<APIGatewayProxyResult> {
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: INSIGHTS_TABLE,
        IndexName: 'advisorId-index',
        KeyConditionExpression: 'advisorId = :aid',
        ExpressionAttributeValues: { ':aid': advisorId },
      }),
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ data: result.Items ?? [] }),
    };
  } catch (err) {
    console.error('Error listing insights:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }
}
