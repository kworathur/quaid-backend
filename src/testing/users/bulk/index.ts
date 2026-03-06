/**
 * POST   /testing/users/bulk  — bulk create Cognito users for frontend tests
 * DELETE /testing/users/bulk  — bulk delete Cognito users for frontend tests
 * Scope: com.apigw/scope1
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  type AttributeType,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import * as z from 'zod';
import {
  errorResponse,
  validationErrorResponse,
} from '../../../lib/serverResponseBuilder';

const client = new CognitoIdentityProviderClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;
const STUDENTS_TABLE = process.env.STUDENTS_TABLE!;
const COUNTER_TABLE = process.env.COUNTER_TABLE!;
const PROFILES_TABLE = process.env.PROFILES_TABLE!;

const StudentSeed = z
  .object({
    id: z.number().int().positive().optional(),
    name: z.string().min(1),
    email: z.string().email(),
    address: z.string(),
    birthdate: z.iso.date(),
    level_of_study: z.enum(['BACHELORS', 'MASTERS', 'DOCTORAL']),
    ssn: z
      .string()
      .regex(/^[0-9]{9}$/)
      .optional(),
    verificationStatus: z
      .enum(['UNVERIFIED', 'VERIFIED', 'NEEDS_REVIEW', 'FRAUDULENT'])
      .optional(),
    consented: z.boolean().optional(),
  })
  .strict();

const BulkCreateRequest = z.object({
  users: z
    .array(
      z.object({
        username: z.string().min(1),
        email: z.string().email().optional(),
        temporaryPassword: z.string().min(8).optional(),
        groups: z.array(z.string().min(1)).optional(),
        attributes: z.record(z.string(), z.string()).optional(),
        student: StudentSeed.optional(),
      }),
    )
    .min(1),
});

const BulkDeleteRequest = z.object({
  usernames: z.array(z.string().min(1)).min(1),
});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  switch (event.httpMethod) {
    case 'POST':
      return bulkCreateUsers(event.body);
    case 'DELETE':
      return bulkDeleteUsers(event.body);
    default:
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
};

async function bulkCreateUsers(
  rawBody: string | null,
): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return errorResponse(400, 'BAD_REQUEST', 'Request body required');
  }

  let body: z.infer<typeof BulkCreateRequest>;
  try {
    body = BulkCreateRequest.parse(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return validationErrorResponse(err);
    }
    return errorResponse(400, 'BAD_REQUEST', 'Invalid JSON');
  }

  const created: string[] = [];
  const failed: Array<{ username: string; error: string }> = [];

  for (const user of body.users) {
    try {
      const userAttributes = [
        ...(user.email ? [{ Name: 'email', Value: user.email }] : []),
        ...Object.entries(user.attributes ?? {}).map(([Name, Value]) => ({
          Name,
          Value,
        })),
      ];

      await client.send(
        new AdminCreateUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: user.username,
          TemporaryPassword: user.temporaryPassword,
          MessageAction: 'SUPPRESS',
          UserAttributes: userAttributes,
        }),
      );

      // Convert temp credentials into a permanent password so test users can
      // sign in directly without FORCE_CHANGE_PASSWORD challenge.
      if (user.temporaryPassword) {
        await client.send(
          new AdminSetUserPasswordCommand({
            UserPoolId: USER_POOL_ID,
            Username: user.username,
            Password: user.temporaryPassword,
            Permanent: true,
          }),
        );
      }

      for (const group of user.groups ?? []) {
        await client.send(
          new AdminAddUserToGroupCommand({
            UserPoolId: USER_POOL_ID,
            Username: user.username,
            GroupName: group,
          }),
        );
      }

      if (user.student) {
        const studentId = await upsertStudentRecord(user.student);
        await client.send(
          new AdminUpdateUserAttributesCommand({
            UserPoolId: USER_POOL_ID,
            Username: user.username,
            UserAttributes: [
              {
                Name: 'custom:studentId',
                Value: String(studentId),
              },
            ],
          }),
        );
      }

      const cognitoUser = await client.send(
        new AdminGetUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: user.username,
        }),
      );

      const attrs = attributesToMap(cognitoUser.UserAttributes ?? []);
      const userSub = attrs.sub;
      if (!userSub) {
        throw new Error('Created user missing sub attribute');
      }

      if (shouldStoreProfile(user.groups)) {
        await upsertProfileRecord({
          userSub,
          username: user.username,
          email: attrs.email ?? user.email ?? '',
          name: attrs.name ?? deriveNameFromAttributes(attrs),
          groups: user.groups ?? [],
        });
      }

      created.push(user.username);
    } catch (err: unknown) {
      console.error('Error creating user:', user.username, err);
      failed.push({
        username: user.username,
        error: (err as { name?: string; message?: string }).message ?? 'Unknown error',
      });
    }
  }

  return {
    statusCode: failed.length === 0 ? 200 : 207,
    body: JSON.stringify({
      message: 'Bulk user create completed',
      created,
      failed,
    }),
  };
}

async function nextStudentId(): Promise<number> {
  const result = await ddb.send(
    new UpdateCommand({
      TableName: COUNTER_TABLE,
      Key: { counter: 'studentCounter' },
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

  const value = result.Attributes?.count;
  if (typeof value !== 'number') {
    throw new Error('Failed to allocate student id');
  }
  return value;
}

async function upsertStudentRecord(
  student: z.infer<typeof StudentSeed>,
): Promise<number> {
  const studentId = student.id ?? (await nextStudentId());

  const item = {
    ...student,
    id: studentId,
    verificationStatus: student.verificationStatus ?? 'UNVERIFIED',
    consented: student.consented ?? false,
  };

  await ddb.send(
    new PutCommand({
      TableName: STUDENTS_TABLE,
      Item: item,
    }),
  );

  return studentId;
}

async function upsertProfileRecord(input: {
  userSub: string;
  username: string;
  email: string;
  name: string;
  groups: string[];
}): Promise<void> {
  const now = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: PROFILES_TABLE,
      Item: {
        userSub: input.userSub,
        username: input.username,
        email: input.email,
        name: input.name,
        roles: input.groups,
        updatedAt: now,
        createdAt: now,
      },
    }),
  );
}

function attributesToMap(attributes: AttributeType[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of attributes) {
    if (attr.Name) {
      out[attr.Name] = attr.Value ?? '';
    }
  }
  return out;
}

function shouldStoreProfile(groups: string[] | undefined): boolean {
  if (!groups || groups.length === 0) {
    return false;
  }
  return groups.includes('advising-advisor') || groups.includes('advising-admin');
}

function deriveNameFromAttributes(attrs: Record<string, string>): string {
  if (attrs.given_name || attrs.family_name) {
    return `${attrs.given_name ?? ''} ${attrs.family_name ?? ''}`.trim();
  }
  if (attrs.email) {
    return attrs.email.split('@')[0];
  }
  return '';
}

async function bulkDeleteUsers(
  rawBody: string | null,
): Promise<APIGatewayProxyResult> {
  if (!rawBody) {
    return errorResponse(400, 'BAD_REQUEST', 'Request body required');
  }

  let body: z.infer<typeof BulkDeleteRequest>;
  try {
    body = BulkDeleteRequest.parse(JSON.parse(rawBody));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return validationErrorResponse(err);
    }
    return errorResponse(400, 'BAD_REQUEST', 'Invalid JSON');
  }

  const deleted: string[] = [];
  const failed: Array<{ username: string; error: string }> = [];

  for (const username of body.usernames) {
    try {
      const user = await client.send(
        new AdminGetUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
        }),
      );
      const attrs = attributesToMap(user.UserAttributes ?? []);
      const studentId = attrs['custom:studentId'];
      const userSub = attrs.sub;

      await client.send(
        new AdminDeleteUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
        }),
      );

      if (studentId) {
        const parsed = parseInt(studentId, 10);
        if (!Number.isNaN(parsed)) {
          await ddb.send(
            new DeleteCommand({
              TableName: STUDENTS_TABLE,
              Key: { id: parsed },
            }),
          );
        }
      }

      if (userSub) {
        await ddb.send(
          new DeleteCommand({
            TableName: PROFILES_TABLE,
            Key: { userSub },
          }),
        );
      }

      deleted.push(username);
    } catch (err: unknown) {
      console.error('Error deleting user:', username, err);
      failed.push({
        username,
        error: (err as { name?: string; message?: string }).message ?? 'Unknown error',
      });
    }
  }

  return {
    statusCode: failed.length === 0 ? 200 : 207,
    body: JSON.stringify({
      message: 'Bulk user delete completed',
      deleted,
      failed,
    }),
  };
}
