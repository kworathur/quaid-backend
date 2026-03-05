import { handler } from '../../../src/cognito/preTokenGeneration/index';

describe('preTokenGeneration handler', () => {
  it('writes legacy claimsOverrideDetails for version 1 events', async () => {
    const event = {
      version: '1',
      triggerSource: 'TokenGeneration_Authentication',
      request: {
        groupConfiguration: {
          groupsToOverride: ['advising-student'],
        },
        userAttributes: {
          'custom:studentId': '42',
        },
      },
      response: {},
    };

    const result = await handler(event);
    expect(result.response.claimsOverrideDetails).toEqual({
      claimsToAddOrOverride: {
        scope: 'com.apigw/advising.student',
        'custom:studentId': '42',
      },
    });
    expect(result.response.claimsAndScopeOverrideDetails).toBeUndefined();
  });

  it('writes claimsAndScopeOverrideDetails for version 2 events', async () => {
    const event = {
      version: '2',
      triggerSource: 'TokenGeneration_Authentication',
      request: {
        groupConfiguration: {
          groupsToOverride: ['advising-student'],
        },
        userAttributes: {
          'custom:studentId': '7',
        },
      },
      response: {},
    };

    const result = await handler(event);
    expect(result.response.claimsAndScopeOverrideDetails).toMatchObject({
      idTokenGeneration: {
        claimsToAddOrOverride: {
          scope: 'com.apigw/advising.student',
          'custom:studentId': '7',
        },
      },
      accessTokenGeneration: {
        claimsToAddOrOverride: {
          'custom:studentId': '7',
        },
        scopesToAdd: ['com.apigw/advising.student'],
      },
    });
    expect(result.response.claimsOverrideDetails).toBeUndefined();
  });
});
