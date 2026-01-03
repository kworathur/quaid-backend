import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
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
  // send verification email
  switch (event.httpMethod) {
    case 'POST':
      if (!event.body) {
        throw new Error(`Request is missing required body.`);
      }

      try {
        // query parameters
        var params;
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
                url: encodeURI(`/api/v1/students?email=${data.Item.email.S}`),
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
        // Creates a new item, or replaces an old item with a new item
        // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#put-property

        try {
          params = {
            TableName: tableName,
            Item: { email, birthdate, address, name, level_of_study, ssn },
          };

          const data = await ddbDocClient.send(new PutCommand(params));
          console.log('Success - item added or updated', data);
        } catch (err) {
          console.log('Error', (err as any).stack);
          return {
            statusCode: 400,
            body: JSON.stringify({ error: (err as any).stack }),
          };
        }

        const response: APIGatewayProxyResult = {
          statusCode: 201,
          body: JSON.stringify({ status: 'CREATED' }),
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
