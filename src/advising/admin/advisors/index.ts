/**
 * GET /advising/admin/advisors  — list all advisors
 * Scope: com.apigw/advising.admin
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  type ListUsersInGroupCommandOutput,
  paginateListUsersInGroup,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { errorResponse } from '../../../lib/serverResponseBuilder';

const client = new CognitoIdentityProviderClient({});

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;
const ADVISOR_GROUP = 'advising-advisor';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 60;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  switch (event.httpMethod) {
    case 'GET':
      return listAdvisors(event.queryStringParameters);
    default:
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
};

async function listAdvisors(
  queryParams: Record<string, string | undefined> | null,
): Promise<APIGatewayProxyResult> {
  const offset = queryParams?.offset ? parseInt(queryParams.offset, 10) : 0;
  const limit = queryParams?.limit
    ? Math.min(parseInt(queryParams.limit, 10), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  if (Number.isNaN(offset) || offset < 0) {
    return errorResponse(400, 'BAD_REQUEST', 'offset must be >= 0');
  }

  if (Number.isNaN(limit) || limit < 1) {
    return errorResponse(400, 'BAD_REQUEST', 'limit must be >= 1');
  }

  try {
    const { users, hasNext } = await fetchAdvisors(offset, limit);
    const currentPage = Math.floor(offset / limit) + 1;
    const prevOffset = Math.max(offset - limit, 0);
    const nextOffset = offset + limit;

    return {
      statusCode: 200,
      body: JSON.stringify({
        data: users.map(mapAdvisorUser),
        pagination: {
          offset,
          limit,
          currentPage,
        },
        links: {
          self: `/advising/admin/advisors?offset=${offset}&limit=${limit}`,
          prev:
            offset > 0
              ? `/advising/admin/advisors?offset=${prevOffset}&limit=${limit}`
              : null,
          next: hasNext
            ? `/advising/admin/advisors?offset=${nextOffset}&limit=${limit}`
            : null,
        },
      }),
    };
  } catch (err) {
    console.error('Error listing advisors:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }
}

async function fetchAdvisors(
  offset: number,
  limit: number,
): Promise<{ users: UserType[]; hasNext: boolean }> {
  let seen = 0;
  const collected: UserType[] = [];
  const paginator = paginateListUsersInGroup(
    { client, pageSize: MAX_PAGE_SIZE },
    {
      UserPoolId: USER_POOL_ID,
      GroupName: ADVISOR_GROUP,
    },
  );

  for await (const response of paginator as AsyncIterable<ListUsersInGroupCommandOutput>) {
    const users = response.Users ?? [];
    for (const user of users) {
      if (seen < offset) {
        seen += 1;
        continue;
      }
      collected.push(user);
      seen += 1;
      if (collected.length >= limit + 1) {
        break;
      }
    }
    if (collected.length >= limit + 1) {
      break;
    }
    if (users.length === 0) {
      break;
    }
  }

  return {
    users: collected.slice(0, limit),
    hasNext: collected.length > limit,
  };
}

function mapAdvisorUser(user: UserType): Record<string, unknown> {
  const attributes: Record<string, string> = {};
  for (const attr of user.Attributes ?? []) {
    if (attr.Name) {
      attributes[attr.Name] = attr.Value ?? '';
    }
  }

  return {
    advisorId: attributes.sub ?? user.Username ?? '',
    username: user.Username ?? '',
    email: attributes.email ?? '',
    name: attributes.name ?? '',
    enabled: user.Enabled ?? false,
    status: user.UserStatus ?? 'UNKNOWN',
    createdAt: user.UserCreateDate?.toISOString(),
    lastModifiedAt: user.UserLastModifiedDate?.toISOString(),
    attributes,
  };
}
