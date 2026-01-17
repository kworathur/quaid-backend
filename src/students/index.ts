import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  AttributeValue,
} from 'aws-lambda';
import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  ScanCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);
import * as z from 'zod';

const DEFAULT_PAGE_SIZE = 25;
// Get the DynamoDB table name from environment variables
const tableName = process.env.STUDENTS_TABLE;
const counterTableName = process.env.COUNTER_TABLE;

const Student = z.object({
  id: z.int().optional(), // ID will be populated by dynamodb
  email: z.email(),
  address: z.string(),
  birthdate: z.iso.date(),
  name: z.string(),
  level_of_study: z.enum(['BACHELORS', 'MASTERS', 'DOCTORAL']),
  ssn: z.string().regex(/^[0-9]{9}$/),
});

const queryPaginatedDynamoList = async (
  params: ScanCommandInput,
  offset: number,
  limit: number,
): Promise<Record<string, AttributeValue>[]> => {
  let lastEvaluatedKey: number | null = null;
  let itemsRetrieved = 0;
  let results: Record<string, AttributeValue>[] = [];
  let data;
  while (itemsRetrieved < offset) {
    // scan the database for student items
    data = await ddbDocClient.send(
      new ScanCommand({
        ...params,
        ...(lastEvaluatedKey != null && {
          ExclusiveStartKey: {
            id: { N: lastEvaluatedKey?.toString() as string },
          },
        }),
      }),
    );

    if (data?.Count == undefined || data?.Items == undefined) {
      console.error(
        `query returned no results: offset ${offset} out of bounds`,
      );
      return [];
    }

    itemsRetrieved += data.Count;

    if (data.LastEvaluatedKey) {
      lastEvaluatedKey = data.LastEvaluatedKey['id'].N
        ? +data.LastEvaluatedKey['id'].N
        : null;
    }
  }

  if (data?.Items == undefined) {
    console.error(`query returned no results: offset ${offset} out of bounds`);
    return [];
  }

  offset = itemsRetrieved - offset;

  // if items count is less than limit and lastEvaluatedKey is not null: keep querying
  results.concat(
    data.Items.slice(offset, limit) as ConcatArray<
      Record<string, AttributeValue>
    >,
  );
  let itemsFound = results.length;

  while (itemsFound < limit && lastEvaluatedKey != null) {
    data = await ddbDocClient.send(
      new ScanCommand({
        ...params,
        Limit: limit - itemsFound,
        ...(lastEvaluatedKey != null && {
          ExclusiveStartKey: {
            id: { N: lastEvaluatedKey?.toString() as string },
          },
        }),
      }),
    );

    if (data?.Count == undefined || data?.Items == undefined) {
      console.error(
        `query returned no results: offset ${offset} out of bounds`,
      );
      return results;
    }
    itemsFound += data.Count;

    if (data.LastEvaluatedKey) {
      lastEvaluatedKey = data.LastEvaluatedKey['id'].N
        ? +data.LastEvaluatedKey['id'].N
        : null;
    }
  }

  return results;
};

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
        // return a paginated list of students
        const offset = event?.queryStringParameters?.page
          ? +event.queryStringParameters.page
          : 0;
        const limit = event?.queryStringParameters?.pageSize
          ? +event?.queryStringParameters?.pageSize
          : DEFAULT_PAGE_SIZE;
        params = {
          TableName: tableName,
        };
        const students = queryPaginatedDynamoList(params, offset, limit);

        const data = await ddbDocClient.send(new ScanCommand(params));
        if (data?.Items) {
          return {
            statusCode: 302,
            body: JSON.stringify({
              items: data?.Items,
            }),
          };
        }
      } catch {
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
              statusCode: 302,
              body: JSON.stringify({
                url: encodeURI(`/students/${data.Item.id.S}`),
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
          console.log('Error', (err as any).stack);
          response = {
            statusCode: 400,
            body: JSON.stringify({ error: (err as any).stack }),
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
