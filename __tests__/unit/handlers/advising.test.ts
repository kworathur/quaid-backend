import { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, ListUsersInGroupCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Set up environment variables before importing handlers
process.env.ADVISING_CONFIG_TABLE = 'AdvisingConfigTable';
process.env.ADVISING_SLOTS_TABLE = 'AdvisingSlotsTable';
process.env.ADVISING_RULES_TABLE = 'AdvisingRulesTable';
process.env.ADVISING_INSIGHTS_TABLE = 'AdvisingInsightsTable';
process.env.STUDENTS_TABLE = 'StudentsTable';
process.env.DEGREE_WORKS_CLUSTER_ARN = 'arn:aws:rds:us-east-1:123456789:cluster:test';
process.env.DEGREE_WORKS_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789:secret:test';
process.env.DEGREE_WORKS_DB_NAME = 'degreeworks';
process.env.COGNITO_USER_POOL_ID = 'us-east-1_testpool';

import { handler as configHandler } from '../../../src/advising/admin/config/index';
import { handler as bookingsHandler } from '../../../src/advising/bookings/index';
import { handler as cancelBookingHandler } from '../../../src/advising/bookings/_bookingId/index';
import { handler as advisorHandler } from '../../../src/advising/advisor/index';
import { handler as sessionsHandler } from '../../../src/advising/sessions/index';
import { handler as rulesHandler } from '../../../src/advising/admin/rules/index';
import { handler as executeInsightHandler } from '../../../src/advising/insights/_insightId/execute/index';
import { handler as advisorsHandler } from '../../../src/advising/admin/advisors/index';

const ddbMock = mockClient(DynamoDBDocumentClient);
const rdsMock = mockClient(RDSDataClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

beforeEach(() => {
  ddbMock.reset();
  rdsMock.reset();
  cognitoMock.reset();
});

// Valid v4 UUIDs for test fixtures (Zod v4 validates version + variant bits)
const SLOT_UUID_1 = 'a0000000-0000-4000-a000-000000000001';
const SLOT_UUID_2 = 'a0000000-0000-4000-a000-000000000099';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    body: null,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    multiValueQueryStringParameters: null,
    ...overrides,
  };
}

function withAdminClaims(sub = 'admin-uuid-1'): Partial<APIGatewayProxyEvent> {
  return {
    requestContext: {
      authorizer: { claims: { sub } },
    } as unknown as APIGatewayProxyEvent['requestContext'],
  };
}

function withStudentClaims(studentId: number): Partial<APIGatewayProxyEvent> {
  return {
    requestContext: {
      authorizer: { claims: { 'custom:studentId': String(studentId) } },
    } as unknown as APIGatewayProxyEvent['requestContext'],
  };
}

function withAdvisorClaims(sub = 'advisor-uuid-1'): Partial<APIGatewayProxyEvent> {
  return {
    requestContext: {
      authorizer: { claims: { sub } },
    } as unknown as APIGatewayProxyEvent['requestContext'],
  };
}

// ── 1. Admin can pause all advising bookings ─────────────────────────────────

describe('Admin can pause all advising bookings', () => {
  it('should set ADVISING_PAUSED to true and return success', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const event = createEvent({
      httpMethod: 'PUT',
      body: JSON.stringify({ configKey: 'ADVISING_PAUSED', value: true, reason: 'Maintenance window' }),
      ...withAdminClaims(),
    });

    const result = await configHandler(event);
    expect(result.statusCode).toEqual(200);

    const body = JSON.parse(result.body);
    expect(body.message).toEqual('Advising paused');
    expect(body.value).toBe(true);
  });

  it('should cause booking attempts to return 503', async () => {
    // Config table says advising is paused
    ddbMock.on(GetCommand).resolves({
      Item: { configKey: 'ADVISING_PAUSED', value: true },
    });

    const event = createEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ slotId: 'a0000000-0000-4000-a000-000000000001' }),
      ...withStudentClaims(1),
    });

    const result = await bookingsHandler(event);
    expect(result.statusCode).toEqual(503);

    const body = JSON.parse(result.body);
    expect(body.error.message).toContain('paused');
  });
});

// ── 2. Student can book only with their assigned advisor ─────────────────────

describe('Student can book an advising session only with their assigned advisor', () => {
  it('should resolve the correct advisor via LAST_NAME_RANGE rule', async () => {
    // Student record
    ddbMock.on(GetCommand).resolves({
      Item: { id: 1, name: 'Jane Martinez' },
    });

    // One active rule: last names M-Z → advisor-uuid-1
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          ruleId: 'rule-1',
          advisorId: 'advisor-uuid-1',
          conditionType: 'LAST_NAME_RANGE',
          parameters: { start: 'M', end: 'Z' },
          priority: 1,
          isActive: true,
        },
      ],
    });
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Attributes: [{ Name: 'name', Value: 'Advisor One' }],
        },
      ],
    });

    const event = createEvent({
      httpMethod: 'GET',
      ...withStudentClaims(1),
    });

    const result = await advisorHandler(event);
    expect(result.statusCode).toEqual(200);

    const body = JSON.parse(result.body);
    expect(body.advisorId).toEqual('advisor-uuid-1');
    expect(body.advisorName).toEqual('Advisor One');
  });

  it('should return 404 when no rule matches the student', async () => {
    // Student whose last name falls outside the only rule's range
    ddbMock.on(GetCommand).resolves({
      Item: { id: 2, name: 'Bob Anderson' },
    });

    // Rule only covers M-Z
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          ruleId: 'rule-1',
          advisorId: 'advisor-uuid-1',
          conditionType: 'LAST_NAME_RANGE',
          parameters: { start: 'M', end: 'Z' },
          priority: 1,
          isActive: true,
        },
      ],
    });

    const event = createEvent({
      httpMethod: 'GET',
      ...withStudentClaims(2),
    });

    const result = await advisorHandler(event);
    expect(result.statusCode).toEqual(404);

    const body = JSON.parse(result.body);
    expect(body.error.message).toContain('No advisor assigned');
  });
});

// ── 3. Students cannot book more than one advising session at a time ─────────

describe('Students cannot book more than one advising session at a time', () => {
  it('should return 409 when student already has a booking this week', async () => {
    // Config: advising is not paused
    ddbMock.on(GetCommand).resolves({
      Item: { configKey: 'ADVISING_PAUSED', value: false },
    });

    // Student already has a booked session this week
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          slotId: 'existing-slot',
          advisorId: 'advisor-uuid-1',
          studentId: 1,
          status: 'BOOKED',
          slotDateTime: new Date().toISOString(),
        },
      ],
    });

    const event = createEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ slotId: 'a0000000-0000-4000-a000-000000000099' }),
      ...withStudentClaims(1),
    });

    const result = await bookingsHandler(event);
    expect(result.statusCode).toEqual(409);

    const body = JSON.parse(result.body);
    expect(body.error.message).toContain('already have a booked session this week');
  });

  it('should allow booking when student has no existing booking this week', async () => {
    // Config: advising is not paused
    ddbMock.on(GetCommand).resolves({
      Item: { configKey: 'ADVISING_PAUSED', value: false },
    });

    // No existing bookings
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    // Slot transition succeeds
    ddbMock.on(UpdateCommand).resolves({});

    const event = createEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ slotId: 'a0000000-0000-4000-a000-000000000001' }),
      ...withStudentClaims(1),
    });

    const result = await bookingsHandler(event);
    expect(result.statusCode).toEqual(201);

    const body = JSON.parse(result.body);
    expect(body.message).toEqual('Booking created');
  });
});

// ── 6. Admin can list advisors ──────────────────────────────────────────────

describe('Admin can list advisors', () => {
  it('should return advisors with pagination metadata', async () => {
    cognitoMock.on(ListUsersInGroupCommand).resolves({
      Users: [
        {
          Username: 'advisor-1',
          Enabled: true,
          UserStatus: 'CONFIRMED',
          UserCreateDate: new Date('2025-01-01T00:00:00.000Z'),
          UserLastModifiedDate: new Date('2025-01-02T00:00:00.000Z'),
          Attributes: [
            { Name: 'sub', Value: 'sub-1' },
            { Name: 'email', Value: 'advisor1@example.com' },
            { Name: 'name', Value: 'Advisor One' },
          ],
        },
      ],
    });

    const event = createEvent({
      httpMethod: 'GET',
      queryStringParameters: { offset: '0', limit: '2' },
      ...withAdminClaims(),
    });

    const result = await advisorsHandler(event);
    expect(result.statusCode).toEqual(200);

    const body = JSON.parse(result.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].advisorId).toEqual('sub-1');
    expect(body.pagination.offset).toEqual(0);
    expect(body.links.next).toBeNull();
  });

  it('should provide a next link when more advisors exist', async () => {
    cognitoMock.on(ListUsersInGroupCommand).resolves({
      Users: [
        { Username: 'advisor-1', Attributes: [{ Name: 'sub', Value: 'sub-1' }] },
        { Username: 'advisor-2', Attributes: [{ Name: 'sub', Value: 'sub-2' }] },
        { Username: 'advisor-3', Attributes: [{ Name: 'sub', Value: 'sub-3' }] },
      ],
    });

    const event = createEvent({
      httpMethod: 'GET',
      queryStringParameters: { offset: '0', limit: '2' },
      ...withAdminClaims(),
    });

    const result = await advisorsHandler(event);
    expect(result.statusCode).toEqual(200);

    const body = JSON.parse(result.body);
    expect(body.data).toHaveLength(2);
    expect(body.links.next).toEqual('/advising/admin/advisors?offset=2&limit=2');
  });
});

// ── 4. A student cannot be assigned to multiple advisors ─────────────────────

describe('A student cannot be assigned to multiple advisors', () => {
  it('should match only the first rule by priority and return a single advisor', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: 1, name: 'Jane Martinez' },
    });

    // Two overlapping rules — both cover "M", but priority 1 wins
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          ruleId: 'rule-low-priority',
          advisorId: 'advisor-uuid-2',
          conditionType: 'LAST_NAME_RANGE',
          parameters: { start: 'A', end: 'Z' },
          priority: 10,
          isActive: true,
        },
        {
          ruleId: 'rule-high-priority',
          advisorId: 'advisor-uuid-1',
          conditionType: 'LAST_NAME_RANGE',
          parameters: { start: 'M', end: 'Z' },
          priority: 1,
          isActive: true,
        },
      ],
    });
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Attributes: [{ Name: 'name', Value: 'Advisor One' }],
        },
      ],
    });

    const event = createEvent({
      httpMethod: 'GET',
      ...withStudentClaims(1),
    });

    const result = await advisorHandler(event);
    expect(result.statusCode).toEqual(200);

    const body = JSON.parse(result.body);
    // Should match the higher-priority (lower number) rule
    expect(body.advisorId).toEqual('advisor-uuid-1');
    expect(body.advisorName).toEqual('Advisor One');
  });
});

// ── 5. Advising mapping rule with non-existent parameters fails ──────────────

describe('Advising mapping rule with non-existent parameters fails with appropriate error', () => {
  it('should return 400 when conditionType is invalid', async () => {
    const event = createEvent({
      httpMethod: 'POST',
      body: JSON.stringify({
        advisorId: 'advisor-uuid-1',
        conditionType: 'NON_EXISTENT_TYPE',
        parameters: { foo: 'bar' },
        priority: 1,
      }),
    });

    const result = await rulesHandler(event);
    expect(result.statusCode).toEqual(400);

    const body = JSON.parse(result.body);
    expect(body.error).toBeDefined();
  });

  it('should return 400 when required fields are missing', async () => {
    const event = createEvent({
      httpMethod: 'POST',
      body: JSON.stringify({
        advisorId: 'advisor-uuid-1',
        // missing conditionType, parameters, priority
      }),
    });

    const result = await rulesHandler(event);
    expect(result.statusCode).toEqual(400);

    const body = JSON.parse(result.body);
    expect(body.error).toBeDefined();
  });

  it('should return 400 when priority is negative', async () => {
    const event = createEvent({
      httpMethod: 'POST',
      body: JSON.stringify({
        advisorId: 'advisor-uuid-1',
        conditionType: 'LAST_NAME_RANGE',
        parameters: { start: 'A', end: 'M' },
        priority: -1,
      }),
    });

    const result = await rulesHandler(event);
    expect(result.statusCode).toEqual(400);

    const body = JSON.parse(result.body);
    expect(body.error).toBeDefined();
  });
});

// ── 6. Attendance insight triggers successfully for absentee student ─────────

describe('Attendance insight triggers successfully for absentee student', () => {
  it('should execute the insight query and return results for the student', async () => {
    // Insight record in DynamoDB
    ddbMock.on(GetCommand).resolves({
      Item: {
        insightId: 'insight-1',
        advisorId: 'advisor-uuid-1',
        templateKey: 'CREDENTIALS_NEAR_COMPLETION',
        parameters: { threshold_percentage: 80 },
      },
    });

    // RDS Data API returns rows
    rdsMock.on(ExecuteStatementCommand).resolves({
      columnMetadata: [
        { name: 'program_name' },
        { name: 'program_code' },
        { name: 'completion_pct' },
      ],
      records: [
        [
          { stringValue: 'Computer Science' },
          { stringValue: 'CS-BS' },
          { doubleValue: 85.5 },
        ],
      ],
    });

    const event = createEvent({
      httpMethod: 'GET',
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims('advisor-uuid-1'),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(200);

    const body = JSON.parse(result.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].program_name).toEqual('Computer Science');
    expect(body.data[0].completion_pct).toEqual(85.5);
    expect(body.studentId).toEqual(42);
  });

  it('should return 403 when advisor tries to execute another advisor\'s insight', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        insightId: 'insight-1',
        advisorId: 'advisor-uuid-OTHER',
        templateKey: 'CREDENTIALS_NEAR_COMPLETION',
        parameters: { threshold_percentage: 80 },
      },
    });

    const event = createEvent({
      httpMethod: 'GET',
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims('advisor-uuid-1'),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(403);
  });

  it('should return 404 when insight does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = createEvent({
      httpMethod: 'GET',
      pathParameters: { insightId: 'nonexistent' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims('advisor-uuid-1'),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(404);
  });
});

// ── 7. Advisor can cancel all upcoming bookings ──────────────────────────────

describe('Advisor can cancel all upcoming bookings', () => {
  const SLOT_A = 'b0000000-0000-4000-a000-000000000001';
  const SLOT_B = 'b0000000-0000-4000-a000-000000000002';

  it('should list all upcoming booked sessions for the advisor', async () => {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          slotId: SLOT_A,
          advisorId: 'advisor-uuid-1',
          studentId: 1,
          status: 'BOOKED',
          slotDateTime: now.toISOString(),
        },
        {
          slotId: SLOT_B,
          advisorId: 'advisor-uuid-1',
          studentId: 2,
          status: 'BOOKED',
          slotDateTime: tomorrow.toISOString(),
        },
      ],
    });

    const event = createEvent({
      httpMethod: 'GET',
      ...withAdvisorClaims('advisor-uuid-1'),
    });

    const result = await sessionsHandler(event);
    expect(result.statusCode).toEqual(200);

    const body = JSON.parse(result.body);
    expect(body.data).toHaveLength(2);
    expect(body.data.map((s: { slotId: string }) => s.slotId)).toEqual([SLOT_A, SLOT_B]);
  });

  it('should successfully cancel a booked session', async () => {
    // Slot lookup returns a BOOKED slot owned by the student
    ddbMock.on(GetCommand).resolves({
      Item: {
        slotId: SLOT_A,
        advisorId: 'advisor-uuid-1',
        studentId: 1,
        status: 'BOOKED',
        slotDateTime: new Date().toISOString(),
      },
    });

    // Conditional update succeeds
    ddbMock.on(UpdateCommand).resolves({});

    const event = createEvent({
      httpMethod: 'DELETE',
      pathParameters: { bookingId: SLOT_A },
      ...withStudentClaims(1),
    });

    const result = await cancelBookingHandler(event);
    expect(result.statusCode).toEqual(200);

    const body = JSON.parse(result.body);
    expect(body.message).toEqual('Booking cancelled');
    expect(body.slotId).toEqual(SLOT_A);
  });

  it('should cancel multiple bookings sequentially', async () => {
    ddbMock.on(GetCommand)
      .resolvesOnce({
        Item: { slotId: SLOT_A, advisorId: 'advisor-uuid-1', studentId: 1, status: 'BOOKED' },
      })
      .resolvesOnce({
        Item: { slotId: SLOT_B, advisorId: 'advisor-uuid-1', studentId: 2, status: 'BOOKED' },
      });

    ddbMock.on(UpdateCommand).resolves({});

    const cancelA = await cancelBookingHandler(createEvent({
      httpMethod: 'DELETE',
      pathParameters: { bookingId: SLOT_A },
      ...withStudentClaims(1),
    }));
    expect(cancelA.statusCode).toEqual(200);

    const cancelB = await cancelBookingHandler(createEvent({
      httpMethod: 'DELETE',
      pathParameters: { bookingId: SLOT_B },
      ...withStudentClaims(2),
    }));
    expect(cancelB.statusCode).toEqual(200);
  });

  it('should return 409 when trying to cancel an already cancelled booking', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { slotId: SLOT_A, advisorId: 'advisor-uuid-1', studentId: 1, status: 'CANCELLED' },
    });

    const event = createEvent({
      httpMethod: 'DELETE',
      pathParameters: { bookingId: SLOT_A },
      ...withStudentClaims(1),
    });

    const result = await cancelBookingHandler(event);
    expect(result.statusCode).toEqual(409);

    const body = JSON.parse(result.body);
    expect(body.error.message).toContain('Cannot cancel');
  });

  it('should return 403 when a different student tries to cancel the booking', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { slotId: SLOT_A, advisorId: 'advisor-uuid-1', studentId: 1, status: 'BOOKED' },
    });

    const event = createEvent({
      httpMethod: 'DELETE',
      pathParameters: { bookingId: SLOT_A },
      ...withStudentClaims(999), // wrong student
    });

    const result = await cancelBookingHandler(event);
    expect(result.statusCode).toEqual(403);
  });
});
