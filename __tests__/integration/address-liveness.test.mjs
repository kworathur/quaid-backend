/**
 * Integration tests for Address Liveness API endpoint
 *
 * These tests verify the complete address liveness check flow, including
 * calling the Melissa Data API for address verification.
 *
 * Required Environment Variables:
 * - API_BASE_URL: Invoke URL (e.g. https://api.quaid-ai.com/v1)
 * - COGNITO_TOKEN_URL: Cognito OAuth2 token endpoint
 * - COGNITO_M2M_CLIENT_ID: M2M client ID
 * - COGNITO_M2M_CLIENT_SECRET: M2M client secret
 *
 * Melissa Data API Key Setup:
 *
 * 1. Get API key from https://www.melissa.com/user/myaccount/data-quality-api
 *
 * 2. Store in SSM:
 *    aws ssm put-parameter \
 *      --name "/quaid/melissa-api-key" \
 *      --type "SecureString" \
 *      --value "YOUR_KEY" \
 *      --region us-east-1
 *
 * 3. Verify:
 *    aws ssm get-parameter \
 *      --name "/quaid/melissa-api-key" \
 *      --with-decryption \
 *      --region us-east-1
 *
 * 4. Rotate:
 *    aws ssm put-parameter \
 *      --name "/quaid/melissa-api-key" \
 *      --type "SecureString" \
 *      --value "NEW_KEY" \
 *      --region us-east-1 \
 *      --overwrite
 *
 * The parameter name matches the MelissaApiKeyParameterName template parameter
 * (default: /quaid/melissa-api-key). Override during sam deploy if using a
 * different path. Key is cached in Lambda memory; rotation takes effect on
 * next cold start.
 */

import { jest } from '@jest/globals';

// Validate required environment variables
const requiredEnvVars = [
  'API_BASE_URL',
  'COGNITO_TOKEN_URL',
  'COGNITO_M2M_CLIENT_ID',
  'COGNITO_M2M_CLIENT_SECRET'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const API_BASE_URL = process.env.API_BASE_URL;
const COGNITO_TOKEN_URL = process.env.COGNITO_TOKEN_URL;
const COGNITO_M2M_CLIENT_ID = process.env.COGNITO_M2M_CLIENT_ID;
const COGNITO_M2M_CLIENT_SECRET = process.env.COGNITO_M2M_CLIENT_SECRET;

// Test constants - Melissa HQ address for stable API results
const TEST_ADDRESS = {
  street: '22382 Avenida Empresa',
  city: 'Rancho Santa Margarita',
  state: 'CA',
  zip: '92688'
};

// Generate unique email for each test run to avoid 409 conflicts
const testTimestamp = Date.now();
const TEST_EMAIL = `integration-test-${testTimestamp}@quaid-test.com`;

// Polling configuration
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30;

// Shared state between test steps
let accessToken;
let studentId;
let inquiryId;

/**
 * Helper function to make authenticated API requests
 */
async function apiRequest(method, path, body = null) {
  const url = `${API_BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const responseBody = await response.text();

  let parsedBody;
  try {
    parsedBody = JSON.parse(responseBody);
  } catch {
    parsedBody = responseBody;
  }

  return {
    status: response.status,
    body: parsedBody
  };
}

/**
 * Helper function to poll for check completion
 */
async function pollForCompletion(studentId, checkId) {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    const response = await apiRequest('GET', `/students/${studentId}/checks/${checkId}/status`);

    if (response.status !== 200) {
      throw new Error(`Failed to get check status: ${response.status} - ${JSON.stringify(response.body)}`);
    }

    const { status, result } = response.body.data;

    if (status === 'COMPLETED') {
      return { status, result };
    }

    if (status === 'FAILED') {
      throw new Error(`Check failed: ${JSON.stringify(response.body.data)}`);
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Check did not complete within ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000} seconds`);
}

describe('Address Liveness Integration Tests', () => {
  // Set Jest timeout to 120 seconds for SQS processing + Melissa API latency
  jest.setTimeout(120000);

  beforeAll(async () => {
    // Authenticate via Cognito M2M client credentials
    const credentials = Buffer.from(`${COGNITO_M2M_CLIENT_ID}:${COGNITO_M2M_CLIENT_SECRET}`).toString('base64');

    const tokenResponse = await fetch(COGNITO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      },
      body: 'grant_type=client_credentials&scope=com.apigw/scope1'
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      throw new Error(`Failed to obtain access token: ${tokenResponse.status} - ${errorBody}`);
    }

    const tokenData = await tokenResponse.json();
    accessToken = tokenData.access_token;

    if (!accessToken) {
      throw new Error('No access token in response');
    }
  });

  test('should create a student', async () => {
    // Format address as "street, city, STATE ZIP" for addressesMatch() logic
    const formattedAddress = `${TEST_ADDRESS.street}, ${TEST_ADDRESS.city}, ${TEST_ADDRESS.state} ${TEST_ADDRESS.zip}`;

    const response = await apiRequest('POST', '/students', {
      name: 'Integration Test',
      email: TEST_EMAIL,
      address: formattedAddress,
      birthdate: '2000-01-15',
      level_of_study: 'BACHELORS'
    });
    if (response.status !== 201) {
      console.error('Create student failed:', JSON.stringify(response.body, null, 2));
    }
    expect(response.status).toBe(201);

    // Extract student ID from the returned URL (e.g., "/students/123")
    const url = response.body.url;
    expect(url).toBeDefined();
    const match = url.match(/\/students\/(\d+)/);
    expect(match).not.toBeNull();
    studentId = parseInt(match[1], 10);
    expect(studentId).toBeDefined();
    expect(Number.isInteger(studentId)).toBe(true);
  });

  test('should confirm student consent', async () => {
    expect(studentId).toBeDefined();

    const response = await apiRequest('POST', `/students/${studentId}/confirmConsent`, {
      consentStatus: true
    });

    expect(response.status).toBe(200);
  });

  test('should create FAFSA application', async () => {
    expect(studentId).toBeDefined();

    const response = await apiRequest('POST', `/students/${studentId}/applications`, {
      fafsa_id: `FAFSA-${testTimestamp}`,
      first_name: 'Integration',
      last_name: 'Test',
      street_address: TEST_ADDRESS.street,
      city: TEST_ADDRESS.city,
      mailing_state: TEST_ADDRESS.state,
      zip_code: TEST_ADDRESS.zip,
      date_of_birth: '2000-01-15'
    });

    if (response.status !== 201) {
      console.error('Create application failed:', JSON.stringify(response.body, null, 2));
    }
    expect(response.status).toBe(201);
  });

  test('should initiate address liveness check', async () => {
    expect(studentId).toBeDefined();

    const response = await apiRequest('POST', `/students/${studentId}/checks/addressLiveness`);

    if (response.status !== 200) {
      console.error('Initiate address liveness check failed:', JSON.stringify(response.body, null, 2));
    }
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.data.status).toBe('QUEUED');
    expect(response.body.data.inquiryId).toBeDefined();

    inquiryId = response.body.data.inquiryId;
  });

  test('should complete address liveness check with Melissa verification result', async () => {
    expect(studentId).toBeDefined();
    expect(inquiryId).toBeDefined();

    const { status, result } = await pollForCompletion(studentId, inquiryId);

    expect(status).toBe('COMPLETED');
    expect(result).toBeDefined();

    // Verify expected result fields from Melissa API
    expect(result).toHaveProperty('addressValid');
    expect(result).toHaveProperty('deliverability');
    expect(result).toHaveProperty('addressType');
    expect(result).toHaveProperty('nameMatch');
    expect(result).toHaveProperty('recentMove');
  });
});
