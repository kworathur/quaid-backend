import * as z from 'zod';

// Schema for FAFSA financial aid applications
export const FinancialAidApplication = z.object({
  appid: z.number().int().optional(), // Auto-generated
  studentId: z.number().int().optional(), // Populated from path parameter
  fafsa_id: z.string().min(1),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  middle_initial: z.string().max(1).optional(),
  street_address: z.string().min(1),
  city: z.string().min(1),
  mailing_state: z.string().length(2),
  zip_code: z.string().regex(/^\d{5}(-\d{4})?$/),
  social_security_number: z
    .string()
    .regex(/^\d{9}$/)
    .optional(),
  date_of_birth: z.iso.date(),
  high_school_name: z.string().optional(),
  high_school_city: z.string().optional(),
  high_school_state: z.string().length(2).optional(),
  students_income: z.number().nonnegative().optional(),
  parents_income: z.number().nonnegative().optional(),
  date_completed: z.iso.date().optional(),
});

export type FinancialAidApplicationType = z.infer<typeof FinancialAidApplication>;

// Schema for the request body (without auto-generated fields)
export const CreateApplicationRequest = FinancialAidApplication.omit({
  appid: true,
  studentId: true,
});

export type CreateApplicationRequestType = z.infer<typeof CreateApplicationRequest>;
