import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import {
  DynamoDBClient,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);
import * as z from 'zod';
import { queryPaginatedDynamoList } from '../lib/paginationUtils';

const DEFAULT_PAGE_SIZE = 25;
// Get the DynamoDB table name from environment variables
const tableName = process.env.STUDENTS_TABLE;
const counterTableName = process.env.COUNTER_TABLE;

const VerificationStatus = z.enum([
  'UNVERIFIED',
  'VERIFIED',
  'NEEDS_REVIEW',
  'FRAUDULENT',
]);

const Student = z.object({
  id: z.int().optional(), // ID will be populated by dynamodb
  email: z.email(),
  address: z.string(),
  birthdate: z.iso.date(),
  name: z.string(),
  level_of_study: z.enum(['BACHELORS', 'MASTERS', 'DOCTORAL']),
  ssn: z
    .string()
    .regex(/^[0-9]{9}$/)
    .optional(),
  verificationStatus: VerificationStatus.default('UNVERIFIED'),
  consented: z.boolean().default(false),
});

// email address: email address, birthdate, street address, legal name, level of study, SSN
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  // All log statements are written to CloudWatch
  console.info('received:', event);
  let params;
  switch (event.httpMethod) {
    case 'GET':
      try {
        const offset = event?.queryStringParameters?.offset
          ? +event.queryStringParameters.offset
          : 0;
        const limit = event?.queryStringParameters?.limit
          ? +event?.queryStringParameters?.limit
          : DEFAULT_PAGE_SIZE;

        if (offset < 0) {
          return {
            statusCode: 400,
            body: JSON.stringify({
              message: 'offset must be >= 0',
            }),
          };
        }

        if (limit < 1) {
          return {
            statusCode: 400,
            body: JSON.stringify({
              message: 'limit must be >= 1',
            }),
          };
        }

        params = {
          TableName: tableName,
        };

        const results = await queryPaginatedDynamoList(
          ddbDocClient,
          params,
          offset,
          limit,
        );

        const currentPage = Math.floor(offset / limit) + 1;
        const prevOffset = Math.max(offset - limit, 0);
        const nextOffset = offset + limit;

        return {
          statusCode: 200,
          body: JSON.stringify({
            data: results,
            pagination: {
              offset,
              limit,
              currentPage,
            },
            links: {
              self: `/students?offset=${offset}&limit=${limit}`,
              prev: offset > 0 ? `/students?offset=${prevOffset}&limit=${limit}` : null,
              next: results.length === limit ? `/students?offset=${nextOffset}&limit=${limit}` : null,
            },
          }),
        };
      } catch (error) {
        console.error('Error fetching students:', error);
        return {
          statusCode: 500,
          body: JSON.stringify({
            message: 'Internal server error',
          }),
        };
      }

    case 'POST':
      if (!event.body) {
        throw new Error(`Request is missing required body.`);
      }

      try {
        const body = Student.parse(JSON.parse(event.body));

        const email = body.email;

        // check if a student already exists
        try {
          params = {
            TableName: tableName,
            Key: {
              email: {
                S: email,
              },
            },
          };
          const data = await ddbDocClient.send(new GetItemCommand(params));
          if (data?.Item) {
            console.log('Found student ', data.Item);
            return {
              statusCode: 409,
              body: JSON.stringify({
                url: encodeURI(`/students/${data.Item.id.S}`),
              }),
            };
          }
        } catch (err) {
          console.log('Error', err instanceof Error ? err.stack : err);
          return {
            statusCode: 400,
            body: JSON.stringify({ error: err instanceof Error ? err.stack : String(err) }),
          };
        }

        const birthdate = body.birthdate;
        const address = body.address;
        const name = body.name;
        const level_of_study = body.level_of_study;
        const ssn = body.ssn;
        const verificationStatus = body.verificationStatus;
        const consented = body.consented;

        // create a new student
        let response: APIGatewayProxyResult;
        try {
          // use an auto-increment for now, later the student ID will come from banner

          const data = await ddbDocClient.send(
            new UpdateCommand({
              TableName: counterTableName,
              Key: { counter: { S: 'studentCounter' } },
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
          if (!data?.Attributes) {
            return {
              statusCode: 500,
              body: JSON.stringify({
                message: 'Failed to create a new student',
              }),
            };
          }
          const nextStudentId = data?.Attributes.count;
          params = {
            TableName: tableName,
            Item: {
              id: nextStudentId,
              email,
              birthdate,
              address,
              name,
              level_of_study,
              ssn,
              verificationStatus,
              consented,
            },
          };

          await ddbDocClient.send(new PutCommand(params));

          response = {
            statusCode: 201,
            body: JSON.stringify({
              url: encodeURI(`/students/${body.id}`),
            }),
          };
        } catch (err) {
          console.log('Error', err instanceof Error ? err.stack : err);
          response = {
            statusCode: 400,
            body: JSON.stringify({ error: err instanceof Error ? err.stack : String(err) }),
          };
        }

        // All log statements are written to CloudWatch
        console.info(
          `response from: ${event.path} statusCode: ${response.statusCode} body: ${response.body}`,
        );
        return response;
      } catch (error) {
        console.error(error);
        if (error instanceof z.ZodError) {
          return {
            statusCode: 400,
            body: JSON.stringify({
              error: z.treeifyError(error),
            }),
          };
        }
        throw new Error(error as string);
      }

    default:
      throw new Error(
        `Unsupported method : ${event.httpMethod}. Accepted methods are POST`,
      );
  }
};
