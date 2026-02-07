import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import * as z from 'zod';
import { CreateApplicationRequest } from '../../../lib/types/application';

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

const studentsTableName = process.env.STUDENTS_TABLE;
const applicationsTableName = process.env.APPLICATIONS_TABLE;
const counterTableName = process.env.COUNTER_TABLE;

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

  let parsedBody;
  try {
    parsedBody = CreateApplicationRequest.parse(JSON.parse(event.body));
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

  try {
    // 3. Verify student exists
    const studentResult = await ddbDocClient.send(
      new GetCommand({
        TableName: studentsTableName,
        Key: { id: studentId },
      }),
    );

    if (!studentResult.Item) {
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

    // 4. Generate application ID via counter table
    const counterResult = await ddbDocClient.send(
      new UpdateCommand({
        TableName: counterTableName,
        Key: { counter: { S: 'applicationCounter' } },
        ReturnValues: 'UPDATED_NEW',
        ExpressionAttributeNames: {
          '#cnt': 'count',
        },
        ExpressionAttributeValues: {
          ':val': 1,
        },
        UpdateExpression: 'ADD #cnt :val',
      }),
    );

    if (!counterResult?.Attributes) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          status: 'error',
          statusCode: 500,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to generate application ID',
          },
        }),
      };
    }

    const appId = counterResult.Attributes.count as number;

    // 5. Store application in ApplicationsTable
    const application = {
      appid: appId,
      studentId: studentId,
      ...parsedBody,
    };

    await ddbDocClient.send(
      new PutCommand({
        TableName: applicationsTableName,
        Item: application,
      }),
    );

    // 6. Return success with application ID
    return {
      statusCode: 201,
      body: JSON.stringify({
        status: 'success',
        statusCode: 201,
        message: 'Application created successfully',
        data: {
          appid: appId,
          studentId: studentId,
        },
      }),
    };
  } catch (error) {
    console.error('Error creating application:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: 'error',
        statusCode: 500,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create application',
        },
      }),
    };
  }
};
