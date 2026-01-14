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

// Get the DynamoDB table name from environment variables
const tableName = process.env.STUDENTS_TABLE;
const Student = z.object({
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
          params = {
            TableName: tableName,
          };
          const data = await ddbDocClient.send(new ScanCommand(params));
          if (data?.Items) {
            return {
              statusCode: 302,
              body: JSON.stringify({
                items: data?.Items,
              }),
            };
          }
        }
      } catch {}

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
              statusCode: 302,
              body: JSON.stringify({
                url: encodeURI(`/students?email=${data.Item.email.S}`),
              }),
            };
          }
        } catch (err) {
          console.log('Error', (err as any).stack);
          return {
            statusCode: 400,
            body: JSON.stringify({ error: (err as any).stack }),
          };
        }

        const birthdate = body.birthdate;
        const address = body.address;
        const name = body.name;
        const level_of_study = body.level_of_study;
        const ssn = body.ssn;

        // create a new student

        try {
          params = {
            TableName: tableName,
            Item: { email, birthdate, address, name, level_of_study, ssn },
          };

          const data = await ddbDocClient.send(new PutCommand(params));
        } catch (err) {
          console.log('Error', (err as any).stack);
          return {
            statusCode: 400,
            body: JSON.stringify({ error: (err as any).stack }),
          };
        }

        const response: APIGatewayProxyResult = {
          statusCode: 201,
          body: JSON.stringify({
            url: encodeURI(`/students?email=${body.email}`),
          }),
        };

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
