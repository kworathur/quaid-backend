import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEvent } from 'aws-lambda';

process.env.ADVISING_INSIGHTS_TABLE = 'AdvisingInsightsTable';
process.env.ADVISING_INSIGHT_TEMPLATES_TABLE = 'AdvisingInsightTemplatesTable';
process.env.STUDENTS_TABLE = 'StudentsTable';
process.env.DEGREE_WORKS_CLUSTER_ARN = 'arn:aws:rds:us-east-1:123456789:cluster:test';
process.env.DEGREE_WORKS_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789:secret:test';
process.env.DEGREE_WORKS_DB_NAME = 'degreeworks';

import { handler as executeInsightHandler } from '../../../src/advising/insights/_insightId/execute/index';

const ddbMock = mockClient(DynamoDBDocumentClient);
const rdsMock = mockClient(RDSDataClient);

beforeEach(() => {
  ddbMock.reset();
  rdsMock.reset();
});

function createEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    body: null,
    path: '/advising/insights/insight-1/execute',
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

function withAdvisorClaims(sub = 'advisor-uuid-1'): Partial<APIGatewayProxyEvent> {
  return {
    requestContext: {
      authorizer: { claims: { sub } },
    } as unknown as APIGatewayProxyEvent['requestContext'],
  };
}

describe('Execute insight handler', () => {
  it('returns 401 when advisor claim is missing', async () => {
    const event = createEvent({
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: '42' },
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(401);
  });

  it('returns 400 when insightId path param is missing', async () => {
    const event = createEvent({
      pathParameters: null,
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(400);
    expect(JSON.parse(result.body).error.message).toContain('insightId');
  });

  it('returns 400 when studentId query param is missing', async () => {
    const event = createEvent({
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: null,
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(400);
    expect(JSON.parse(result.body).error.message).toContain('studentId');
  });

  it('returns 400 when studentId is not a number', async () => {
    const event = createEvent({
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: 'abc' },
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(400);
    expect(JSON.parse(result.body).error.message).toContain('valid integer');
  });

  it('returns 404 when insight is not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = createEvent({
      pathParameters: { insightId: 'missing' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(404);
  });

  it('returns 500 when insight lookup fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('ddb failed'));

    const event = createEvent({
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(500);
  });

  it('returns 403 when advisor does not own the insight', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        insightId: 'insight-1',
        advisorId: 'advisor-uuid-other',
        templateKey: 'CREDENTIALS_NEAR_COMPLETION',
        parameters: { threshold_percentage: 80 },
      },
    });

    const event = createEvent({
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims('advisor-uuid-1'),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(403);
  });

  it('returns 400 for unknown templateKey', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        insightId: 'insight-1',
        advisorId: 'advisor-uuid-1',
        templateKey: 'UNKNOWN_TEMPLATE',
        parameters: {},
      },
    });

    const event = createEvent({
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(400);
    expect(JSON.parse(result.body).error.message).toContain('Unknown templateKey');
  });

  it('returns 400 when stored parameters are invalid for template', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        insightId: 'insight-1',
        advisorId: 'advisor-uuid-1',
        templateKey: 'CREDENTIALS_NEAR_COMPLETION',
        parameters: { threshold_percentage: 101 },
      },
    });

    const event = createEvent({
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(400);
    expect(JSON.parse(result.body).error.message).toContain('Stored parameters are invalid');
  });

  it('returns 404 when template SQL record is missing', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          insightId: 'insight-1',
          advisorId: 'advisor-uuid-1',
          templateKey: 'CREDENTIALS_NEAR_COMPLETION',
          parameters: { threshold_percentage: 80 },
        },
      })
      .resolvesOnce({ Item: { id: 42, name: 'Jane Doe' } })
      .resolvesOnce({ Item: undefined });

    const event = createEvent({
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(404);
    expect(JSON.parse(result.body).error.message).toContain('Template SQL not found');
  });

  it('returns 500 when template SQL lookup throws', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          insightId: 'insight-1',
          advisorId: 'advisor-uuid-1',
          templateKey: 'CREDENTIALS_NEAR_COMPLETION',
          parameters: { threshold_percentage: 80 },
        },
      })
      .resolvesOnce({ Item: { id: 42, name: 'Jane Doe' } })
      .rejectsOnce(new Error('template table unavailable'));

    const event = createEvent({
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(500);
  });

  it('returns 500 when query execution fails', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          insightId: 'insight-1',
          advisorId: 'advisor-uuid-1',
          templateKey: 'CREDENTIALS_NEAR_COMPLETION',
          parameters: { threshold_percentage: 80 },
        },
      })
      .resolvesOnce({ Item: { id: 42, name: 'Jane Doe' } })
      .resolvesOnce({ Item: { templateKey: 'CREDENTIALS_NEAR_COMPLETION', sql: 'SELECT 1' } });

    rdsMock.on(ExecuteStatementCommand).rejects(new Error('rds failure'));

    const event = createEvent({
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(500);
  });

  it('executes query, maps fields, and uses insight messageTemplate override', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          insightId: 'insight-1',
          advisorId: 'advisor-uuid-1',
          templateKey: 'CREDENTIALS_NEAR_COMPLETION',
          parameters: { threshold_percentage: 80 },
          messageTemplate: 'Hello {{student_name}}: {{program_code}} at {{completion_pct}}%',
        },
      })
      .resolvesOnce({ Item: { id: 42, name: 'Jane Doe' } })
      .resolvesOnce({
        Item: {
          templateKey: 'CREDENTIALS_NEAR_COMPLETION',
          sql: 'SELECT :student_id AS student_id, :threshold_percentage AS threshold_percentage',
        },
      });

    rdsMock.on(ExecuteStatementCommand).resolves({
      columnMetadata: [
        { name: 'program_code' },
        { name: 'completion_pct' },
        { name: 'is_eligible' },
        { name: 'reason' },
      ],
      records: [
        [
          { stringValue: 'CS-BS' },
          { doubleValue: 85.5 },
          { booleanValue: true },
          { isNull: true },
        ],
      ],
    });

    const event = createEvent({
      pathParameters: { insightId: 'insight-1' },
      queryStringParameters: { studentId: '42' },
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(200);

    const body = JSON.parse(result.body);
    expect(body.data).toEqual([
      {
        program_code: 'CS-BS',
        completion_pct: 85.5,
        is_eligible: true,
        reason: null,
      },
    ]);
    expect(body.messages).toEqual(['Hello Jane Doe: CS-BS at 85.5%']);
    expect(body.insightId).toEqual('insight-1');
    expect(body.studentId).toEqual(42);

    const executeCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0].args[0].input.sql).toContain('SELECT :student_id');
    expect(executeCalls[0].args[0].input.parameters).toEqual([
      { name: 'student_id', value: { longValue: 42 } },
      { name: 'threshold_percentage', value: { doubleValue: 80 } },
    ]);
  });

  it('continues when student name lookup fails and uses default template', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          insightId: 'insight-2',
          advisorId: 'advisor-uuid-1',
          templateKey: 'SCHOLARSHIP_ELIGIBILITY',
          parameters: { scholarship_name: 'HOPE' },
        },
      })
      .rejectsOnce(new Error('student table issue'))
      .resolvesOnce({
        Item: {
          templateKey: 'SCHOLARSHIP_ELIGIBILITY',
          sql: 'SELECT 1',
        },
      });

    rdsMock.on(ExecuteStatementCommand).resolves({
      columnMetadata: [{ name: 'scholarship_name' }, { name: 'status' }, { name: 'reason' }],
      records: [[{ stringValue: 'HOPE' }, { stringValue: 'ELIGIBLE' }, { stringValue: 'All good' }]],
    });

    const event = createEvent({
      pathParameters: { insightId: 'insight-2' },
      queryStringParameters: { studentId: '7' },
      ...withAdvisorClaims(),
    });

    const result = await executeInsightHandler(event);
    expect(result.statusCode).toEqual(200);

    const body = JSON.parse(result.body);
    expect(body.messages).toEqual(['HOPE — Status: ELIGIBLE. All good']);

    const executeCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(executeCalls[0].args[0].input.parameters).toEqual([
      { name: 'student_id', value: { longValue: 7 } },
      { name: 'scholarship_name', value: { stringValue: 'HOPE' } },
    ]);
  });
});
