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

const VerificationStatus = z.enum([
  'UNVERIFIED',
  'VERIFIED',
  'NEEDS_REVIEW',
  'FRAUDULENT',
]);

const UpdateStatusRequest = z.object({
  status: VerificationStatus,
});

type VerificationStatusType = z.infer<typeof VerificationStatus>;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

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

  switch (event.httpMethod) {
    case 'GET':
      return getStudentById(studentId);

    case 'PUT':
      return updateStudentStatus(studentId, event.body);

    default:
      return {
        statusCode: 405,
        body: JSON.stringify({
          status: 'error',
          statusCode: 405,
          error: {
            code: 'BAD_REQUEST',
            message: `Method ${event.httpMethod} not allowed`,
          },
        }),
      };
  }
};

async function getStudentById(studentId: number): Promise<APIGatewayProxyResult> {
  try {
    const result = await ddbDocClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { id: studentId },
      }),
    );

    if (!result.Item) {
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

    return {
      statusCode: 200,
      body: JSON.stringify(result.Item),
    };
  } catch (error) {
    console.error('Error fetching student:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: 'error',
        statusCode: 500,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch student',
        },
      }),
    };
  }
}

async function updateStudentStatus(
  studentId: number,
  body: string | null,
): Promise<APIGatewayProxyResult> {
  if (!body) {
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

  let parsedBody: { status: VerificationStatusType };
  try {
    parsedBody = UpdateStatusRequest.parse(JSON.parse(body));
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

  const newStatus = parsedBody.status;

  try {
    // First, get the current student to check existence and get previous status
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

    const previousStatus: VerificationStatusType =
      getResult.Item.verificationStatus || 'UNVERIFIED';

    // Update the student's verification status
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { id: studentId },
        UpdateExpression: 'SET verificationStatus = :status',
        ExpressionAttributeValues: {
          ':status': newStatus,
        },
      }),
    );

    // If marked as FRAUDULENT, log placeholder for future SIS hold integration
    if (newStatus === 'FRAUDULENT') {
      console.info(
        `[HOLD_PLACEHOLDER] Student ${studentId} marked as FRAUDULENT. ` +
          `TODO: Integrate with SIS to place registration hold.`,
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'success',
        statusCode: 200,
        message: `Successfully updated student(id:${studentId}) status from ${previousStatus} to ${newStatus}`,
      }),
    };
  } catch (error) {
    console.error('Error updating student status:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: 'error',
        statusCode: 500,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update student status',
        },
      }),
    };
  }
}
