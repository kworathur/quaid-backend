import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

// Get the DynamoDB table name from environment variables
const tableName = process.env.STUDENTS_TABLE;

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
              error: `query parameter "email" is required`,
            }),
          };
        }
      } catch {}
    default:
      throw new Error(
        `Unsupported method : ${event.httpMethod}. Accepted methods are GET`,
      );
  }
};
