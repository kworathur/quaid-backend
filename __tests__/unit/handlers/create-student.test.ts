// Import handler function from students/index.ts
import { handler } from '../../../src/students/index';
// Import DynamoDB clients
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Set up environment variables
process.env.STUDENTS_TABLE = 'StudentsTable';
process.env.COUNTER_TABLE = 'CounterTable';

describe('Test create student handler', function () {
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    ddbMock.reset();
  });

  // Helper to create a valid student payload
  const createValidStudentPayload = (overrides = {}) => ({
    email: 'test@example.com',
    address: '123 Main St, City, ST 12345',
    birthdate: '2000-01-15',
    name: 'John Doe',
    level_of_study: 'BACHELORS',
    ...overrides,
  });

  // Helper to create a mock API Gateway event
  const createEvent = (body: unknown, method = 'POST'): APIGatewayProxyEvent => ({
    httpMethod: method,
    body: body ? JSON.stringify(body) : null,
    path: '/students',
    pathParameters: null,
    queryStringParameters: null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '/students',
    multiValueQueryStringParameters: null,
  });

  describe('POST /students - Create student', () => {
    it('should create a new student successfully', async () => {
      const studentPayload = createValidStudentPayload();

      // Mock GetItemCommand - student does not exist
      ddbMock.on(GetItemCommand).resolves({
        Item: undefined,
      });

      // Mock UpdateCommand - counter increment returns new ID
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { count: 1 },
      });

      // Mock PutCommand - student creation succeeds
      ddbMock.on(PutCommand).resolves({});

      const event = createEvent(studentPayload);
      const result = await handler(event);

      expect(result.statusCode).toEqual(201);
      const body = JSON.parse(result.body);
      expect(body).toHaveProperty('url');
    });

    it('should return 409 when student with email already exists', async () => {
      const studentPayload = createValidStudentPayload();

      // Mock GetItemCommand - student already exists
      ddbMock.on(GetItemCommand).resolves({
        Item: {
          id: { S: '123' },
          email: { S: 'test@example.com' },
        },
      });

      const event = createEvent(studentPayload);
      const result = await handler(event);

      expect(result.statusCode).toEqual(409);
      const body = JSON.parse(result.body);
      expect(body).toHaveProperty('url');
      expect(body.url).toContain('/students/');
    });

    it('should return 400 for invalid email format', async () => {
      const studentPayload = createValidStudentPayload({
        email: 'not-a-valid-email',
      });

      const event = createEvent(studentPayload);
      const result = await handler(event);

      expect(result.statusCode).toEqual(400);
      const body = JSON.parse(result.body);
      expect(body).toHaveProperty('error');
    });

    it('should return 400 for missing required fields', async () => {
      const incompletePayload = {
        email: 'test@example.com',
        // missing: address, birthdate, name, level_of_study
      };

      const event = createEvent(incompletePayload);
      const result = await handler(event);

      expect(result.statusCode).toEqual(400);
      const body = JSON.parse(result.body);
      expect(body).toHaveProperty('error');
    });

    it('should return 400 for invalid birthdate format', async () => {
      const studentPayload = createValidStudentPayload({
        birthdate: '15-01-2000', // Wrong format, should be YYYY-MM-DD
      });

      const event = createEvent(studentPayload);
      const result = await handler(event);

      expect(result.statusCode).toEqual(400);
    });

    it('should return 400 for invalid level_of_study', async () => {
      const studentPayload = createValidStudentPayload({
        level_of_study: 'INVALID_LEVEL',
      });

      const event = createEvent(studentPayload);
      const result = await handler(event);

      expect(result.statusCode).toEqual(400);
    });

    it('should return 400 for invalid SSN format', async () => {
      const studentPayload = createValidStudentPayload({
        ssn: '123-45-6789', // Should be 9 digits without dashes
      });

      const event = createEvent(studentPayload);
      const result = await handler(event);

      expect(result.statusCode).toEqual(400);
    });

    it('should accept valid SSN format', async () => {
      const studentPayload = createValidStudentPayload({
        ssn: '123456789',
      });

      // Mock GetItemCommand - student does not exist
      ddbMock.on(GetItemCommand).resolves({
        Item: undefined,
      });

      // Mock UpdateCommand - counter increment
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { count: 2 },
      });

      // Mock PutCommand
      ddbMock.on(PutCommand).resolves({});

      const event = createEvent(studentPayload);
      const result = await handler(event);

      expect(result.statusCode).toEqual(201);
    });

    it('should return 500 when counter table fails to return attributes', async () => {
      const studentPayload = createValidStudentPayload();

      // Mock GetItemCommand - student does not exist
      ddbMock.on(GetItemCommand).resolves({
        Item: undefined,
      });

      // Mock UpdateCommand - counter fails to return attributes
      ddbMock.on(UpdateCommand).resolves({
        Attributes: undefined,
      });

      const event = createEvent(studentPayload);
      const result = await handler(event);

      expect(result.statusCode).toEqual(500);
      const body = JSON.parse(result.body);
      expect(body.message).toEqual('Failed to create a new student');
    });

    it('should throw error when body is missing', async () => {
      const event = createEvent(null);

      await expect(handler(event)).rejects.toThrow('Request is missing required body');
    });

    it('should set default values for verificationStatus and consented', async () => {
      const studentPayload = createValidStudentPayload();

      // Mock GetItemCommand
      ddbMock.on(GetItemCommand).resolves({
        Item: undefined,
      });

      // Mock UpdateCommand
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { count: 3 },
      });

      // Capture the PutCommand to verify the item
      let capturedItem: Record<string, unknown> | undefined;
      ddbMock.on(PutCommand).callsFake((input) => {
        capturedItem = input.Item as Record<string, unknown>;
        return {};
      });

      const event = createEvent(studentPayload);
      await handler(event);

      expect(capturedItem?.verificationStatus).toEqual('UNVERIFIED');
      expect(capturedItem?.consented).toEqual(false);
    });
  });

  describe('Unsupported methods', () => {
    it('should throw error for unsupported HTTP methods', async () => {
      const event = createEvent({}, 'DELETE');

      await expect(handler(event)).rejects.toThrow('Unsupported method');
    });
  });
});
