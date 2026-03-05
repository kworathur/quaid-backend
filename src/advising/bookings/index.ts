/**
 * POST /advising/bookings  — book a slot
 * GET  /advising/bookings  — list student's booked sessions
 * Scope: com.apigw/advising.student
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import * as z from 'zod';
import {
  errorResponse,
  validationErrorResponse,
} from '../../lib/serverResponseBuilder';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const SLOTS_TABLE = process.env.ADVISING_SLOTS_TABLE!;
const CONFIG_TABLE = process.env.ADVISING_CONFIG_TABLE!;

const BookingRequest = z.object({
  slotId: z.string().uuid(),
  bookingDescription: z.string().optional(),
});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);
  console.info(
    'received authorizer claims ',
    event.requestContext?.authorizer?.claims,
  );

  const studentIdClaim =
    event.requestContext?.authorizer?.claims?.['custom:studentId'];
  if (!studentIdClaim) {
    return errorResponse(400, 'BAD_REQUEST', 'Missing custom:studentId claim');
  }
  const studentId = parseInt(studentIdClaim, 10);

  switch (event.httpMethod) {
    case 'GET':
      return listBookings(studentId);
    case 'POST':
      return createBooking(studentId, event.body);
    default:
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
};

async function isAdvisingPaused(): Promise<boolean> {
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
  const result = await ddb.send(
    new GetCommand({
      TableName: CONFIG_TABLE,
      Key: { configKey: 'ADVISING_PAUSED' },
    }),
  );
  return result.Item?.value === true;
}

async function createBooking(
  studentId: number,
  rawBody: string | null,
): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return errorResponse(400, 'BAD_REQUEST', 'Request body required');
  }

  let body: z.infer<typeof BookingRequest>;
  try {
    body = BookingRequest.parse(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return validationErrorResponse(err);
    }
    return errorResponse(400, 'BAD_REQUEST', 'Invalid JSON');
  }

  // Check global pause state
  try {
    if (await isAdvisingPaused()) {
      return errorResponse(
        503,
        'SERVICE_UNAVAILABLE',
        'Advising bookings are currently paused',
      );
    }
  } catch (err) {
    console.error('Error checking advising pause state:', err);
  }

  // Enforce one session per student per week
  // Determine the ISO week window for the slot's date by first fetching the slot
  // We check the current calendar week (Monday 00:00 UTC – Sunday 23:59:59 UTC)
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0 = Sun
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(
    now.getTime() - daysToMonday * 24 * 60 * 60 * 1000,
  );
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);

  try {
    const existing = await ddb.send(
      new QueryCommand({
        TableName: SLOTS_TABLE,
        IndexName: 'studentId-slotDateTime-index',
        KeyConditionExpression:
          'studentId = :sid AND slotDateTime BETWEEN :ws AND :we',
        FilterExpression: '#st = :booked',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':sid': studentId,
          ':ws': weekStart.toISOString(),
          ':we': weekEnd.toISOString(),
          ':booked': 'BOOKED',
        },
      }),
    );

    if (existing.Items && existing.Items.length > 0) {
      return errorResponse(
        409,
        'CONFLICT',
        'You already have a booked session this week',
      );
    }
  } catch (err) {
    console.error('Error checking existing bookings:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  // Atomically transition slot from AVAILABLE → BOOKED
  const bookingCreatedAt = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: SLOTS_TABLE,
        Key: { slotId: body.slotId },
        UpdateExpression:
          'SET #st = :booked, studentId = :sid, bookingCreatedAt = :ts' +
          (body.bookingDescription ? ', bookingDescription = :desc' : ''),
        ConditionExpression: '#st = :available',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':booked': 'BOOKED',
          ':available': 'AVAILABLE',
          ':sid': studentId,
          ':ts': bookingCreatedAt,
          ...(body.bookingDescription
            ? { ':desc': body.bookingDescription }
            : {}),
        },
      }),
    );
  } catch (err: unknown) {
    const errName = (err as { name?: string }).name;
    if (errName === 'ConditionalCheckFailedException') {
      return errorResponse(
        409,
        'CONFLICT',
        'Slot is no longer available (already booked or cancelled)',
      );
    }
    console.error('Error booking slot:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 201,
    body: JSON.stringify({ message: 'Booking created', slotId: body.slotId }),
  };
}

async function listBookings(studentId: number): Promise<APIGatewayProxyResult> {
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: SLOTS_TABLE,
        IndexName: 'studentId-slotDateTime-index',
        KeyConditionExpression: 'studentId = :sid',
        FilterExpression: '#st = :booked',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':sid': studentId,
          ':booked': 'BOOKED',
        },
      }),
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ data: result.Items ?? [] }),
    };
  } catch (err) {
    console.error('Error listing bookings:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }
}
