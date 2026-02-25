/**
 * GET /advising/insights/{insightId}/execute?studentId={id}
 * Scope: com.apigw/advising.advisor
 *
 * Loads the insight config, resolves the SQL template, binds parameters, and
 * executes the query against the Aurora Serverless v2 DegreeWorks DB via the
 * RDS Data API.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  RDSDataClient,
  ExecuteStatementCommand,
  Field,
} from '@aws-sdk/client-rds-data';
import { INSIGHT_TEMPLATES } from '../../../../lib/advisingInsightTemplates';
import type { TemplateKeyType } from '../../../../lib/types/advising';
import { errorResponse } from '../../../../lib/serverResponseBuilder';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const rdsData = new RDSDataClient({});

const INSIGHTS_TABLE = process.env.ADVISING_INSIGHTS_TABLE!;
const CLUSTER_ARN = process.env.DEGREE_WORKS_CLUSTER_ARN!;
const SECRET_ARN = process.env.DEGREE_WORKS_SECRET_ARN!;
const DB_NAME = process.env.DEGREE_WORKS_DB_NAME!;

/** Convert RDS Data API Field to a plain JS value */
function fieldToValue(field: Field): unknown {
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.isNull) return null;
  return null;
}

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

  const studentIdParam = event.queryStringParameters?.studentId;
  if (!studentIdParam) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      'Missing studentId query parameter',
    );
  }
  const studentId = parseInt(studentIdParam, 10);
  if (isNaN(studentId)) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      'studentId must be a valid integer',
    );
  }

  // Load insight from DynamoDB
  let insight: Record<string, unknown>;
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: INSIGHTS_TABLE, Key: { insightId } }),
    );
    if (!result.Item) {
      return errorResponse(404, 'RESOURCE_NOT_FOUND', 'Insight not found');
    }
    insight = result.Item as Record<string, unknown>;
  } catch (err) {
    console.error('Error fetching insight:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  // Verify the insight belongs to the calling advisor
  if (insight.advisorId !== advisorId) {
    return errorResponse(403, 'FORBIDDEN', 'Forbidden');
  }

  const templateKey = insight.templateKey as TemplateKeyType;
  const template = INSIGHT_TEMPLATES[templateKey];
  if (!template) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      `Unknown templateKey: ${templateKey}`,
    );
  }

  const configParams = insight.parameters as Record<string, unknown>;

  // Validate stored parameters against template schema
  const validation = template.paramSchema.safeParse(configParams);
  if (!validation.success) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      'Stored parameters are invalid for this template',
    );
  }

  // Build RDS named parameter bindings
  // student_id always comes from the request; other params from stored config
  const parameters = [
    { name: 'student_id', value: { longValue: studentId } },
    ...Object.entries(configParams).map(([name, value]) => ({
      name,
      value:
        typeof value === 'number'
          ? { doubleValue: value }
          : { stringValue: String(value) },
    })),
  ];

  // Execute the query
  let rows: Record<string, unknown>[];
  try {
    const response = await rdsData.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DB_NAME,
        sql: template.sql,
        parameters,
        includeResultMetadata: true,
      }),
    );

    const columnNames =
      response.columnMetadata?.map((col) => col.name ?? '') ?? [];
    rows = (response.records ?? []).map((record) =>
      Object.fromEntries(
        columnNames.map((col, i) => [col, fieldToValue(record[i])]),
      ),
    );
  } catch (err) {
    console.error('Error executing insight query:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ data: rows, insightId, studentId }),
  };
};
