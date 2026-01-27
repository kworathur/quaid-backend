// Melissa Personator API types

export interface PersonatorRequest {
  // Name fields
  first?: string;
  last?: string;
  full?: string;

  // Address fields
  a1?: string; // Address Line 1
  a2?: string; // Address Line 2
  city?: string;
  state?: string;
  postal?: string;
  country?: string;

  // Additional verification fields
  dob?: string; // Date of birth (MM/DD/YYYY)
  ssn?: string; // Last 4 of SSN
  email?: string;
  phone?: string;
}

export interface PersonatorRecord {
  // Result codes
  Results: string;

  // Standardized name output
  NamePrefix: string;
  NameFirst: string;
  NameMiddle: string;
  NameLast: string;
  NameSuffix: string;
  NameFull: string;

  // Standardized address output
  AddressLine1: string;
  AddressLine2: string;
  City: string;
  State: string;
  PostalCode: string;
  Plus4: string;
  Country: string;

  // Address type indicators
  AddressType: string; // S=Street, H=Highrise, P=PO Box, R=Rural, etc.
  AddressTypeCode: string;
  DeliveryIndicator: string; // R=Residential, B=Business
  DeliveryPointCheckDigit: string;

  // Move information
  MoveDate: string;
  MoveTypeCode: string;

  // Verification results
  DateOfBirth: string;
  DateOfDeath: string;
  AddressKey: string;
  MelissaAddressKey: string;
  MelissaAddressKeyBase: string;

  // Additional fields
  Latitude: string;
  Longitude: string;
  DistanceFromInputLocation: string;

  // Confidence scores
  RecordExtras: string;
}

export interface PersonatorResponse {
  Version: string;
  TransmissionReference: string;
  TransmissionResults: string;
  TotalRecords: string;
  Records: PersonatorRecord[];
}

// Result code prefixes for address verification
export const ADDRESS_RESULT_CODES = {
  AS01: 'Address verified to the street level',
  AS02: 'Address verified to the building or suite level',
  AS03: 'Address verified to the mailbox level',
  AS09: 'Address verified to the foreign address',
  AS10: 'Address matched to CMRA (mail receiving agency)',
  AS13: 'Address verified to the census tract/block level',
  AS14: 'Address matched to partial address',
  AS15: 'Address matched to the building level',
  AS16: 'Address matched to the unit level',
  AS17: 'Address matched to the suite level',
  AS18: 'Address matched to the house level',
  AS20: 'Address verified but unable to determine deliverability',
  AS23: 'Address has missing or non-standard info but still deliverable',
  AE01: 'Address verification failed - no match found',
  AE02: 'Address verification failed - no street number',
  AE03: 'Address verification failed - no valid city/state/ZIP',
  AE04: 'Address verification failed - non-deliverable',
  AE05: 'Address verification failed - multiple matches',
  AE08: 'Address verification failed - invalid building',
  AE09: 'Address verification failed - invalid suite',
  AE10: 'Address verification failed - missing suite',
  AE11: 'Address verification failed - missing house number',
  AE12: 'Address verification failed - missing directional',
  AE13: 'Address verification failed - missing suffix',
  AE14: 'Address verification failed - invalid address range',
} as const;

// Helper to check if address is verified (has a valid result code)
export function isAddressVerified(results: string): boolean {
  // Split results by comma and check for valid address status codes
  const codes = results.split(',');
  return codes.some(
    (code) =>
      code.startsWith('AS01') ||
      code.startsWith('AS02') ||
      code.startsWith('AS03'),
  );
}

// Helper to determine deliverability
export function getDeliverability(
  results: string,
): 'DELIVERABLE' | 'UNDELIVERABLE' | 'UNKNOWN' {
  const codes = results.split(',');

  // Check for verified addresses
  const hasVerified = codes.some(
    (code) =>
      code.startsWith('AS01') ||
      code.startsWith('AS02') ||
      code.startsWith('AS03'),
  );

  if (hasVerified) {
    return 'DELIVERABLE';
  }

  // Check for explicit undeliverable codes
  const hasUndeliverable = codes.some(
    (code) =>
      code.startsWith('AE01') ||
      code.startsWith('AE04') ||
      code.startsWith('AE14'),
  );

  if (hasUndeliverable) {
    return 'UNDELIVERABLE';
  }

  return 'UNKNOWN';
}

// Helper to determine address type
export function getAddressType(
  addressType: string,
  deliveryIndicator: string,
): 'RESIDENTIAL' | 'COMMERCIAL' | 'PO_BOX' | 'UNKNOWN' {
  if (addressType === 'P') {
    return 'PO_BOX';
  }

  if (deliveryIndicator === 'R') {
    return 'RESIDENTIAL';
  }

  if (deliveryIndicator === 'B') {
    return 'COMMERCIAL';
  }

  return 'UNKNOWN';
}

// Helper to check for recent move (within 6 months)
export function isRecentMove(moveDate: string): boolean {
  if (!moveDate) {
    return false;
  }

  const move = new Date(moveDate);
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  return move >= sixMonthsAgo;
}

// Helper to check if names match (case-insensitive, normalizes whitespace)
export function doNamesMatch(
  inputFirst: string,
  inputLast: string,
  returnedFull: string,
): boolean {
  const normalizedReturned = returnedFull
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  // Check if the input name parts are contained in the returned full name
  // This handles middle names and suffixes
  const normalizedFirst = inputFirst.toLowerCase().trim();
  const normalizedLast = inputLast.toLowerCase().trim();

  return (
    normalizedReturned.includes(normalizedFirst) &&
    normalizedReturned.includes(normalizedLast)
  );
}
