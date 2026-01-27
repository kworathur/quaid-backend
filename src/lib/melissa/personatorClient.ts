import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  PersonatorRequest,
  PersonatorResponse,
  isAddressVerified,
  getDeliverability,
  getAddressType,
  isRecentMove,
  doNamesMatch,
} from './types';
import { VerificationResultType } from '../types/inquiry';

const MELISSA_PERSONATOR_URL =
  'https://personator.melissadata.net/v3/WEB/ContactVerify/doContactVerify';

const ssmClient = new SSMClient({});

let cachedApiKey: string | null = null;

async function getMelissaApiKey(): Promise<string> {
  if (cachedApiKey) {
    return cachedApiKey;
  }

  const paramName = process.env.MELISSA_API_KEY_PARAM;
  if (!paramName) {
    throw new Error('MELISSA_API_KEY_PARAM environment variable not set');
  }

  const response = await ssmClient.send(
    new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    }),
  );

  if (!response.Parameter?.Value) {
    throw new Error('Melissa API key not found in SSM Parameter Store');
  }

  cachedApiKey = response.Parameter.Value;
  return cachedApiKey;
}

export interface VerifyAddressInput {
  firstName: string;
  lastName: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  dateOfBirth?: string; // YYYY-MM-DD format
}

export interface VerifyAddressOutput {
  rawResponse: PersonatorResponse;
  result: VerificationResultType;
}

export async function verifyAddress(
  input: VerifyAddressInput,
): Promise<VerifyAddressOutput> {
  const apiKey = await getMelissaApiKey();

  // Convert DOB from YYYY-MM-DD to MM/DD/YYYY for Melissa API
  let dobFormatted: string | undefined;
  if (input.dateOfBirth) {
    const [year, month, day] = input.dateOfBirth.split('-');
    dobFormatted = `${month}/${day}/${year}`;
  }

  const request: PersonatorRequest = {
    first: input.firstName,
    last: input.lastName,
    a1: input.streetAddress,
    city: input.city,
    state: input.state,
    postal: input.zipCode,
    country: 'US',
    dob: dobFormatted,
  };

  const queryParams = new URLSearchParams({
    id: apiKey,
    act: 'Check,Verify,Append',
    format: 'json',
    ...Object.fromEntries(
      Object.entries(request).filter(
        ([, v]) => v !== undefined,
      ) as [string, string][],
    ),
  });

  const url = `${MELISSA_PERSONATOR_URL}?${queryParams.toString()}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Melissa API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data: PersonatorResponse = await response.json();

  if (!data.Records || data.Records.length === 0) {
    throw new Error('Melissa API returned no records');
  }

  const record = data.Records[0];

  // Parse the response into our standardized result format
  const result: VerificationResultType = {
    addressValid: isAddressVerified(record.Results),
    deliverability: getDeliverability(record.Results),
    addressType: getAddressType(record.AddressType, record.DeliveryIndicator),
    nameMatch: doNamesMatch(input.firstName, input.lastName, record.NameFull),
    recentMove: isRecentMove(record.MoveDate),
  };

  return {
    rawResponse: data,
    result,
  };
}
