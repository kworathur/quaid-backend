/**
 * GET /advising/students
 * Scope: com.apigw/advising.advisor
 *
 * Returns students assigned to the authenticated advisor by evaluating active
 * assignment rules in ascending priority order.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  type ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { errorResponse } from '../../lib/serverResponseBuilder';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const RULES_TABLE = process.env.ADVISING_RULES_TABLE!;
const STUDENTS_TABLE = process.env.STUDENTS_TABLE!;

type AssignmentRule = {
  advisorId: string;
  conditionType: string;
  parameters: { start?: string; end?: string };
  priority: number;
};

type StudentRecord = {
  id?: number;
  name?: string;
  [key: string]: unknown;
};

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

  let rules: AssignmentRule[];
  try {
    rules = (await scanAllItems<AssignmentRule>({
      TableName: RULES_TABLE,
      FilterExpression: 'isActive = :true',
      ExpressionAttributeValues: { ':true': true },
    })).sort(
      (a, b) => (a.priority ?? 0) - (b.priority ?? 0),
    );
  } catch (err) {
    console.error('Error fetching rules:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  let students: StudentRecord[];
  try {
    students = await scanAllItems<StudentRecord>({
      TableName: STUDENTS_TABLE,
    });
  } catch (err) {
    console.error('Error fetching students:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  const assignedStudents = students.filter((student) => {
    const studentAdvisorId = resolveAdvisorForStudent(student, rules);
    return studentAdvisorId === advisorId;
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ data: assignedStudents }),
  };
};

function resolveAdvisorForStudent(
  student: StudentRecord,
  rules: AssignmentRule[],
): string | null {
  const studentName = String(student.name ?? '').trim();
  if (!studentName) {
    return null;
  }

  const nameParts = studentName.split(/\s+/);
  const lastName = (
    nameParts.length > 1 ? nameParts[nameParts.length - 1] : nameParts[0]
  ).toUpperCase();

  for (const rule of rules) {
    if (rule.conditionType !== 'LAST_NAME_RANGE') {
      continue;
    }

    const start = String(rule.parameters?.start ?? '').toUpperCase();
    const end = String(rule.parameters?.end ?? '').toUpperCase();

    if (!start || !end) {
      continue;
    }

    if (lastName >= start && lastName <= end) {
      return rule.advisorId;
    }
  }

  return null;
}

async function scanAllItems<T>(params: ScanCommandInput): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey = params.ExclusiveStartKey;

  do {
    const result = await ddb.send(
      new ScanCommand({
        ...params,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as T[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}
