/**
 * GET /advising/advisor
 * Scope: com.apigw/advising.student
 *
 * Returns the assigned advisor for the authenticated student by evaluating
 * assignment rules stored in AdvisingRulesTable against the student record.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type AttributeType,
} from '@aws-sdk/client-cognito-identity-provider';
import { errorResponse } from '../../lib/serverResponseBuilder';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const cognito = new CognitoIdentityProviderClient({});

const RULES_TABLE = process.env.ADVISING_RULES_TABLE!;
const STUDENTS_TABLE = process.env.STUDENTS_TABLE!;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  // The student's numeric ID comes from the Cognito claim injected by API Gateway
  const studentIdClaim =
    event.requestContext?.authorizer?.claims?.['custom:studentId'];

  if (!studentIdClaim) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      'Missing custom:studentId claim in token',
    );
  }

  const studentId = parseInt(studentIdClaim, 10);

  // Load the student record to get the last name (needed for LAST_NAME_RANGE rule)
  let studentName: string;
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: STUDENTS_TABLE, Key: { id: studentId } }),
    );
    if (!result.Item) {
      return errorResponse(404, 'RESOURCE_NOT_FOUND', 'Student not found');
    }
    studentName = result.Item.name as string;
  } catch (err) {
    console.error('Error fetching student:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  // Derive last name (assume "First Last" format; fall back to full name)
  const nameParts = studentName.trim().split(/\s+/);
  const lastName = (
    nameParts.length > 1 ? nameParts[nameParts.length - 1] : nameParts[0]
  ).toUpperCase();

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
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
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
    return errorResponse(
      404,
      'RESOURCE_NOT_FOUND',
      'No advisor assigned for this student',
    );
  }

  let advisorName: string;
  try {
    advisorName = await lookupAdvisorName(assignedAdvisorId);
  } catch (err) {
    console.error('Error fetching advisor:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  if (!advisorName) {
    return errorResponse(404, 'RESOURCE_NOT_FOUND', 'Advisor not found');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ advisorId: assignedAdvisorId, advisorName }),
  };
};

async function lookupAdvisorName(advisorId: string): Promise<string> {
  const result = await cognito.send(
    new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `sub = "${advisorId}"`,
      Limit: 1,
    }),
  );

  const user = result.Users?.[0];
  if (!user) {
    return '';
  }

  const attrs = attributesToMap(user.Attributes ?? []);
  if (attrs.name) {
    return attrs.name;
  }

  const given = attrs.given_name ?? '';
  const family = attrs.family_name ?? '';
  const combined = `${given} ${family}`.trim();
  return combined;
}

function attributesToMap(attributes: AttributeType[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of attributes) {
    if (attr.Name) {
      out[attr.Name] = attr.Value ?? '';
    }
  }
  return out;
}
