import * as z from 'zod';

// ── Slot / Booking ──────────────────────────────────────────────────────────

export const SlotStatus = z.enum(['AVAILABLE', 'BOOKED', 'CANCELLED']);

export const Slot = z.object({
  slotId: z.string().uuid(),
  advisorId: z.string(),
  slotDateTime: z.string(), // ISO-8601 UTC
  status: SlotStatus,
  advisorCreatedAt: z.string(),
  // Populated only when booked
  studentId: z.number().int().optional(),
  bookingDescription: z.string().optional(),
  bookingCreatedAt: z.string().optional(),
  advisorDisplayName: z.string().optional(),
});

export type SlotType = z.infer<typeof Slot>;

// ── Insight ──────────────────────────────────────────────────────────────────

export const TemplateKey = z.enum([
  'CREDENTIALS_NEAR_COMPLETION',
  'SCHOLARSHIP_ELIGIBILITY',
  'SUGGESTED_COURSES',
]);

export type TemplateKeyType = z.infer<typeof TemplateKey>;

export const Insight = z.object({
  insightId: z.string().uuid(),
  advisorId: z.string(),
  name: z.string(),
  templateKey: TemplateKey,
  parameters: z.record(z.string(), z.unknown()),
  messageTemplate: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type InsightType = z.infer<typeof Insight>;

// ── Assignment Rule ───────────────────────────────────────────────────────────

export const ConditionType = z.enum(['LAST_NAME_RANGE']);

export const AssignmentRule = z.object({
  ruleId: z.string().uuid(),
  advisorId: z.string(),
  conditionType: ConditionType,
  parameters: z.record(z.string(), z.unknown()),
  priority: z.number().int(),
  isActive: z.boolean(),
  createdAt: z.string(),
});

export type AssignmentRuleType = z.infer<typeof AssignmentRule>;

// ── Config ────────────────────────────────────────────────────────────────────

export const AdvisingConfig = z.object({
  configKey: z.string(),
  value: z.unknown(),
  reason: z.string().optional(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
});

export type AdvisingConfigType = z.infer<typeof AdvisingConfig>;
