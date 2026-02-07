import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(dynamoClient);

const inquiriesTableName = process.env.INQUIRIES_TABLE;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  // 1. Validate path parameters
  const studentIdParam = event.pathParameters?.studentId;
  const checkIdParam = event.pathParameters?.checkId;

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

  if (!checkIdParam) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        status: 'error',
        statusCode: 400,
        error: {
          code: 'BAD_REQUEST',
          message: 'Missing checkId path parameter',
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

  // Validate UUID format for checkId
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(checkIdParam)) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        status: 'error',
        statusCode: 400,
        error: {
          code: 'BAD_REQUEST',
          message: 'checkId must be a valid UUID',
        },
      }),
    };
  }

  try {
    // 2. Fetch inquiry from InquiriesTable
    const inquiryResult = await ddbDocClient.send(
      new GetCommand({
        TableName: inquiriesTableName,
        Key: { inquiryId: checkIdParam },
      }),
    );

    if (!inquiryResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          status: 'error',
          statusCode: 404,
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: `Inquiry with ID '${checkIdParam}' not found`,
          },
        }),
      };
    }

    const inquiry = inquiryResult.Item;

    // 3. Verify inquiry belongs to the student
    if (inquiry.studentId !== studentId) {
      return {
        statusCode: 403,
        body: JSON.stringify({
          status: 'error',
          statusCode: 403,
          error: {
            code: 'FORBIDDEN',
            message: 'This inquiry does not belong to the specified student',
          },
        }),
      };
    }

    // 4. Build response based on inquiry status
    const response: Record<string, unknown> = {
      inquiryId: inquiry.inquiryId,
      studentId: inquiry.studentId,
      checkType: inquiry.checkType,
      status: inquiry.status,
      createdAt: inquiry.createdAt,
      updatedAt: inquiry.updatedAt,
    };

    // Include additional fields based on status
    if (inquiry.status === 'COMPLETED') {
      response.result = inquiry.result;
      response.inputAddress = inquiry.inputAddress;
    } else if (inquiry.status === 'FAILED') {
      response.errorMessage = inquiry.errorMessage;
      response.inputAddress = inquiry.inputAddress;
    } else if (inquiry.status === 'IN_PROGRESS' || inquiry.status === 'QUEUED') {
      response.inputAddress = inquiry.inputAddress;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'success',
        statusCode: 200,
        data: response,
      }),
    };
  } catch (error) {
    console.error('Error fetching inquiry status:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: 'error',
        statusCode: 500,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch inquiry status',
        },
      }),
    };
  }
};
