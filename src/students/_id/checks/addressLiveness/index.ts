import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { v4 as uuidv4 } from 'uuid';
import { AddressLivenessMessageType, InquiryType } from '../../../../lib/types/inquiry';

const dynamoClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(dynamoClient);
const sqsClient = new SQSClient({});

const studentsTableName = process.env.STUDENTS_TABLE;
const applicationsTableName = process.env.APPLICATIONS_TABLE;
const inquiriesTableName = process.env.INQUIRIES_TABLE;
const queueUrl = process.env.ADDRESS_LIVENESS_QUEUE_URL;

// Helper function to normalize address for comparison
function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,#-]/g, '')
    .trim();
}

// Helper function to compare addresses
function addressesMatch(
  studentAddress: string,
  fafsaStreet: string,
  fafsaCity: string,
  fafsaState: string,
  fafsaZip: string,
): boolean {
  // Normalize the student address (which is a single string)
  const normalizedStudentAddress = normalizeAddress(studentAddress);

  // Build FAFSA address and normalize
  const fafsaAddress = `${fafsaStreet} ${fafsaCity} ${fafsaState} ${fafsaZip}`;
  const normalizedFafsaAddress = normalizeAddress(fafsaAddress);

  // Check if the student address contains key components from FAFSA
  // This is a simplified check - in production you might want more sophisticated matching
  const fafsaStreetNorm = normalizeAddress(fafsaStreet);
  const fafsaCityNorm = normalizeAddress(fafsaCity);

  return (
    normalizedStudentAddress.includes(fafsaStreetNorm) ||
    normalizedFafsaAddress.includes(normalizeAddress(studentAddress.split(',')[0] || ''))
  ) && (
    normalizedStudentAddress.includes(fafsaCityNorm) ||
    normalizedStudentAddress.includes(normalizeAddress(fafsaState))
  );
}

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

  try {
    // 2. Fetch student from StudentsTable
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

    const student = studentResult.Item;

    // 3. Check if student has consented
    if (student.consented !== true) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          status: 'error',
          statusCode: 400,
          error: {
            code: 'CONSENT_REQUIRED',
            message: 'Student must consent to background checks before verification',
          },
        }),
      };
    }

    // 4. Fetch FAFSA application from ApplicationsTable (by studentId)
    const applicationResult = await ddbDocClient.send(
      new QueryCommand({
        TableName: applicationsTableName,
        IndexName: 'studentId-index',
        KeyConditionExpression: 'studentId = :studentId',
        ExpressionAttributeValues: {
          ':studentId': studentId,
        },
        Limit: 1,
      }),
    );

    if (!applicationResult.Items || applicationResult.Items.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          status: 'error',
          statusCode: 400,
          error: {
            code: 'APPLICATION_NOT_FOUND',
            message: 'No FAFSA application found for this student',
          },
        }),
      };
    }

    const application = applicationResult.Items[0];

    // 5. Check address match between student record and FAFSA
    const studentAddress = student.address as string;
    const fafsaStreet = application.street_address as string;
    const fafsaCity = application.city as string;
    const fafsaState = application.mailing_state as string;
    const fafsaZip = application.zip_code as string;

    if (!addressesMatch(studentAddress, fafsaStreet, fafsaCity, fafsaState, fafsaZip)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          status: 'error',
          statusCode: 400,
          error: {
            code: 'ADDRESS_MISMATCH',
            message: 'Address mismatch between student record and FAFSA application',
          },
        }),
      };
    }

    // 6. Check for existing QUEUED or IN_PROGRESS inquiry
    // Note: IN operator doesn't work in KeyConditionExpression, so we check both statuses separately
    const queuedResult = await ddbDocClient.send(
      new QueryCommand({
        TableName: inquiriesTableName,
        IndexName: 'studentId-status-index',
        KeyConditionExpression: 'studentId = :studentId AND #status = :status',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':studentId': studentId,
          ':status': 'QUEUED',
        },
      }),
    );

    const inProgressResult = await ddbDocClient.send(
      new QueryCommand({
        TableName: inquiriesTableName,
        IndexName: 'studentId-status-index',
        KeyConditionExpression: 'studentId = :studentId AND #status = :status',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':studentId': studentId,
          ':status': 'IN_PROGRESS',
        },
      }),
    );

    const hasExistingInquiry =
      (queuedResult.Items && queuedResult.Items.length > 0) ||
      (inProgressResult.Items && inProgressResult.Items.length > 0);

    if (hasExistingInquiry) {
      const existingInquiry = queuedResult.Items?.[0] || inProgressResult.Items?.[0];
      return {
        statusCode: 409,
        body: JSON.stringify({
          status: 'error',
          statusCode: 409,
          error: {
            code: 'INQUIRY_ALREADY_EXISTS',
            message: 'An address liveness check is already in progress for this student',
            existingInquiryId: existingInquiry?.inquiryId,
          },
        }),
      };
    }

    // 7. Generate UUID and create inquiry record
    const inquiryId = uuidv4();
    const now = new Date().toISOString();

    const inquiry: InquiryType = {
      inquiryId,
      studentId,
      checkType: 'ADDRESS_LIVENESS',
      status: 'QUEUED',
      createdAt: now,
      updatedAt: now,
      inputAddress: {
        street: fafsaStreet,
        city: fafsaCity,
        state: fafsaState,
        zip: fafsaZip,
      },
    };

    await ddbDocClient.send(
      new PutCommand({
        TableName: inquiriesTableName,
        Item: inquiry,
      }),
    );

    // 8. Send SQS message
    const sqsMessage: AddressLivenessMessageType = {
      inquiryId,
      studentId,
    };

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(sqsMessage),
      }),
    );

    // 9. Return success with inquiry UUID
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'success',
        statusCode: 200,
        message: 'Address liveness check initiated',
        data: {
          inquiryId,
          checkType: 'ADDRESS_LIVENESS',
          status: 'QUEUED',
        },
      }),
    };
  } catch (error) {
    console.error('Error initiating address liveness check:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: 'error',
        statusCode: 500,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to initiate address liveness check',
        },
      }),
    };
  }
};
