import * as z from 'zod';

export const InquiryStatus = z.enum([
  'QUEUED',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
]);

export type InquiryStatusType = z.infer<typeof InquiryStatus>;

export const CheckType = z.enum(['ADDRESS_LIVENESS']);

export type CheckTypeType = z.infer<typeof CheckType>;

export const InputAddress = z.object({
  street: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
});

export type InputAddressType = z.infer<typeof InputAddress>;

export const VerificationResult = z.object({
  addressValid: z.boolean(),
  deliverability: z.enum(['DELIVERABLE', 'UNDELIVERABLE', 'UNKNOWN']),
  addressType: z.enum(['RESIDENTIAL', 'COMMERCIAL', 'PO_BOX', 'UNKNOWN']),
  nameMatch: z.boolean(),
  recentMove: z.boolean(),
});

export type VerificationResultType = z.infer<typeof VerificationResult>;

export const Inquiry = z.object({
  inquiryId: z.string().uuid(),
  studentId: z.number().int(),
  checkType: CheckType,
  status: InquiryStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
  inputAddress: InputAddress.optional(),
  melissaResponse: z.record(z.string(), z.unknown()).optional(),
  result: VerificationResult.optional(),
  errorMessage: z.string().optional(),
});

export type InquiryType = z.infer<typeof Inquiry>;

// Schema for the SQS message payload
export const AddressLivenessMessage = z.object({
  inquiryId: z.string().uuid(),
  studentId: z.number().int(),
});

export type AddressLivenessMessageType = z.infer<typeof AddressLivenessMessage>;
