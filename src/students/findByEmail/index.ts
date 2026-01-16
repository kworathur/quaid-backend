import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);
import * as z from 'zod';

const DEFAULT_PAGE_SIZE = 25;
// Get the DynamoDB table name from environment variables
const tableName = process.env.STUDENTS_TABLE;
const Student = z.object({
  id: z.string().optional(), // ID will be populated by dynamodb
  email: z.email(),
  address: z.string(),
  birthdate: z.iso.date(),
  name: z.string(),
  level_of_study: z.enum(['BACHELORS', 'MASTERS', 'DOCTORAL']),
  ssn: z.string().regex(/^[0-9]{9}$/),
});
// email address: email address, birthdate, street address, legal name, level of study, SSN

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  // All log statements are written to CloudWatch
  console.info('received:', event);
  var params;
  switch (event.httpMethod) {
    case 'GET':
      try {
        if (event?.queryStringParameters?.email) {
          const email = event?.queryStringParameters?.email;
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
            return {
              statusCode: 200,
              body: JSON.stringify(data?.Item),
            };
          } else {
            return {
              statusCode: 404,
              body: JSON.stringify({
                error: `Student with email ${email} not found`,
              }),
            };
          }
        } else {
          return {
            statusCode: 400,
            body: JSON.stringify({
              error: `query parameter email is required`,
            }),
          };
        }
      } catch {}
    default:
      throw new Error(
        `Unsupported method : ${event.httpMethod}. Accepted methods are POST`,
      );
  }
};
