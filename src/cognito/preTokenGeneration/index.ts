/**
 * Cognito Pre-Token Generation Lambda trigger.
 *
 * Reads the authenticated user's Cognito groups from the trigger event and
 * injects the corresponding advising resource-server scope into the JWT's
 * `scope` claim.  This makes the token compatible with the API Gateway
 * AuthorizationScopes checks without any changes to the authorizer config.
 *
 * Only fires for user-pool auth flows — client_credentials (M2M) flows are
 * unaffected, so existing integration tests remain green.
 */

interface CognitoPreTokenEvent {
  triggerSource: string;
  request: {
    groupConfiguration?: {
      groupsToOverride?: string[];
    };
    clientMetadata?: Record<string, string>;
  };
  response: {
    claimsOverrideDetails?: {
      claimsToAddOrOverride?: Record<string, string>;
      claimsToSuppress?: string[];
      groupOverrideDetails?: {
        groupsToOverride?: string[];
        iamRolesToOverride?: string[];
        preferredRole?: string;
      };
    };
  };
}

const GROUP_TO_SCOPE: Record<string, string> = {
  'advising-student': 'com.apigw/advising.student',
  'advising-advisor': 'com.apigw/advising.advisor',
  'advising-admin': 'com.apigw/advising.admin',
};

export const handler = async (
  event: CognitoPreTokenEvent,
): Promise<CognitoPreTokenEvent> => {
  console.info('preTokenGeneration trigger:', JSON.stringify(event));

  const groups: string[] =
    event.request.groupConfiguration?.groupsToOverride ?? [];

  // Collect advising scopes for any groups the user belongs to
  const advisingScopes: string[] = [];
  for (const group of groups) {
    const scope = GROUP_TO_SCOPE[group];
    if (scope) {
      advisingScopes.push(scope);
    }
  }

  if (advisingScopes.length > 0) {
    // Cognito expects the scope claim as a space-separated string
    event.response.claimsOverrideDetails = {
      claimsToAddOrOverride: {
        scope: advisingScopes.join(' '),
      },
    };
  }

  return event;
};
