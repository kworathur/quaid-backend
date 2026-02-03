import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import * as z from 'zod';

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

const tableName = process.env.STUDENTS_TABLE;

const ConfirmConsentRequest = z.object({
  consentStatus: z.boolean(),
});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  // 1. Validate path parameter
  const studentIdParam = event.pathParameters?.studentId;

  if (!studentIdParam) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        status: 'error',
        statusCode: 400,
        error: {
          code: 'BAD_REQUEST',
          message: 'Missing studentId path parameter',
        },
      }),
    };
  }

  const studentId = parseInt(studentIdParam, 10);

  if (isNaN(studentId)) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        status: 'error',
        statusCode: 400,
        error: {
          code: 'BAD_REQUEST',
          message: 'studentId must be a valid integer',
        },
      }),
    };
  }

  // 2. Validate request body
  if (!event.body) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        status: 'error',
        statusCode: 400,
        error: {
          code: 'BAD_REQUEST',
          message: 'Request body is required',
        },
      }),
    };
  }

  let parsedBody: { consentStatus: boolean };
  try {
    parsedBody = ConfirmConsentRequest.parse(JSON.parse(event.body));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          status: 'error',
          statusCode: 400,
          error: {
            code: 'BAD_REQUEST',
            message: 'Invalid request body',
            details: z.treeifyError(error),
          },
        }),
      };
    }
    return {
      statusCode: 400,
      body: JSON.stringify({
        status: 'error',
        statusCode: 400,
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid JSON in request body',
        },
      }),
    };
  }

  // 3. Validate consentStatus is true (grant-only)
  if (parsedBody.consentStatus !== true) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        status: 'error',
        statusCode: 400,
        error: {
          code: 'BAD_REQUEST',
          message: 'consentStatus must be true. Revoking consent is not supported.',
        },
      }),
    };
  }

  try {
    // 4. Fetch student
    const getResult = await ddbDocClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { id: studentId },
      }),
    );

    if (!getResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          status: 'error',
          statusCode: 404,
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: `Student with ID '${studentId}' not found`,
          },
        }),
      };
    }

    // 5. Check if already consented
    if (getResult.Item.consented === true) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          status: 'error',
          statusCode: 400,
          error: {
            code: 'BAD_REQUEST',
            message: 'Student has already consented to background checks',
          },
        }),
      };
    }

    // 6. Update consent status
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { id: studentId },
        UpdateExpression: 'SET consented = :status',
        ExpressionAttributeValues: {
          ':status': true,
        },
      }),
    );

    // 7. Return success
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'success',
        statusCode: 200,
        message: 'Student has consented to background checks',
      }),
    };
  } catch (error) {
    console.error('Error processing consent:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: 'error',
        statusCode: 500,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to process consent',
        },
      }),
    };
  }
};
