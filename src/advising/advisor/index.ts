/**
 * GET /advising/advisor
 * Scope: com.apigw/advising.student
 *
 * Returns the assigned advisor for the authenticated student by evaluating
 * assignment rules stored in AdvisingRulesTable against the student record.
 */
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const RULES_TABLE = process.env.ADVISING_RULES_TABLE!;
const STUDENTS_TABLE = process.env.STUDENTS_TABLE!;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  // The student's numeric ID comes from the Cognito claim injected by API Gateway
  const studentIdClaim =
    event.requestContext?.authorizer?.claims?.['custom:studentId'];

  if (!studentIdClaim) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        message: 'Missing custom:studentId claim in token',
      }),
    };
  }

  const studentId = parseInt(studentIdClaim, 10);

  // Load the student record to get the last name (needed for LAST_NAME_RANGE rule)
  let studentName: string;
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: STUDENTS_TABLE, Key: { id: studentId } }),
    );
    if (!result.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Student not found' }),
      };
    }
    studentName = result.Item.name as string;
  } catch (err) {
    console.error('Error fetching student:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }

  // Derive last name (assume "First Last" format; fall back to full name)
  const nameParts = studentName.trim().split(/\s+/);
  const lastName = (nameParts.length > 1 ? nameParts[nameParts.length - 1] : nameParts[0]).toUpperCase();

  // Load all active rules, sorted by priority ascending
  let rules: Record<string, unknown>[];
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: RULES_TABLE,
        FilterExpression: 'isActive = :true',
        ExpressionAttributeValues: { ':true': true },
      }),
    );
    rules = (result.Items ?? []).sort(
      (a, b) => (a.priority as number) - (b.priority as number),
    );
  } catch (err) {
    console.error('Error fetching rules:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Internal server error' }) };
  }

  // Evaluate rules in priority order
  let assignedAdvisorId: string | null = null;
  for (const rule of rules) {
    if (rule.conditionType === 'LAST_NAME_RANGE') {
      const params = rule.parameters as { start: string; end: string };
      const start = params.start.toUpperCase();
      const end = params.end.toUpperCase();
      if (lastName >= start && lastName <= end) {
        assignedAdvisorId = rule.advisorId as string;
        break;
      }
    }
  }

  if (!assignedAdvisorId) {
    return {
      statusCode: 404,
      body: JSON.stringify({ message: 'No advisor assigned for this student' }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ advisorId: assignedAdvisorId }),
  };
};
