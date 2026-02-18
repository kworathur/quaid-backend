import * as z from 'zod';
import type { TemplateKeyType } from './types/advising';

// Parameter schemas per template
const CredentialsNearCompletionParams = z.object({
  threshold_percentage: z.number().int().min(0).max(100),
});

const ScholarshipEligibilityParams = z.object({
  scholarship_name: z.enum(['ZELL_MILLER', 'HOPE', 'PELL']),
});

const SuggestedCoursesParams = z.object({
  department: z.string().optional(),
});

// SQL templates (parameterized with named bindings — never string-interpolated)
const CREDENTIALS_NEAR_COMPLETION_SQL = `
WITH matched AS (
  SELECT dr.program_id,
         COUNT(*) AS matched_count,
         p.total_credits_required
  FROM degree_requirements dr
  JOIN programs p ON p.program_id = dr.program_id AND p.is_active
  JOIN student_courses sc
       ON sc.subject_code = dr.subject_code
      AND sc.course_number = dr.course_number
      AND sc.student_id = :student_id
      AND sc.status = 'COMPLETED'
  WHERE dr.req_type = 'SPECIFIC_COURSE'
    AND dr.program_id NOT IN (
      SELECT sp.program_id FROM student_programs sp WHERE sp.student_id = :student_id
    )
  GROUP BY dr.program_id, p.total_credits_required
)
SELECT p.program_name, p.program_code,
       ROUND(m.matched_count::NUMERIC / m.total_credits_required * 100, 1) AS completion_pct
FROM matched m
JOIN programs p ON p.program_id = m.program_id
WHERE m.matched_count::NUMERIC / m.total_credits_required * 100 >= :threshold_percentage
ORDER BY completion_pct DESC;
`.trim();

const SCHOLARSHIP_ELIGIBILITY_SQL = `
SELECT s.scholarship_name, ss.status, ss.reason,
       sr.rule_type, sr.rule_operator, sr.rule_value, sr.disqualifies
FROM scholarships s
JOIN student_scholarships ss ON ss.scholarship_id = s.scholarship_id
                             AND ss.student_id = :student_id
JOIN scholarship_rules sr    ON sr.scholarship_id = s.scholarship_id
WHERE s.scholarship_code = :scholarship_name
ORDER BY sr.disqualifies DESC;
`.trim();

const SUGGESTED_COURSES_SQL = `
SELECT c.subject_code, c.course_number, c.course_name, c.credit_hours, c.description
FROM courses c
WHERE c.is_active
  AND (:department::TEXT IS NULL OR c.subject_code = :department)
  AND NOT EXISTS (
    SELECT 1 FROM student_courses sc
    WHERE sc.student_id = :student_id
      AND sc.course_id = c.course_id
      AND sc.status IN ('COMPLETED', 'IN_PROGRESS')
  )
ORDER BY c.subject_code, c.course_number
LIMIT 10;
`.trim();

export interface InsightTemplate {
  description: string;
  paramSchema: z.ZodType;
  sql: string;
  /** Names of parameters that come from the stored insight config (not from the request) */
  configParamNames: string[];
}

export const INSIGHT_TEMPLATES: Record<TemplateKeyType, InsightTemplate> = {
  CREDENTIALS_NEAR_COMPLETION: {
    description:
      'Undeclared programs the student is close to completing, based on a completion threshold.',
    paramSchema: CredentialsNearCompletionParams,
    sql: CREDENTIALS_NEAR_COMPLETION_SQL,
    configParamNames: ['threshold_percentage'],
  },
  SCHOLARSHIP_ELIGIBILITY: {
    description:
      'Scholarship qualification and disqualification status for a specific scholarship.',
    paramSchema: ScholarshipEligibilityParams,
    sql: SCHOLARSHIP_ELIGIBILITY_SQL,
    configParamNames: ['scholarship_name'],
  },
  SUGGESTED_COURSES: {
    description:
      'Courses in a department (or all departments) that the student has not yet taken.',
    paramSchema: SuggestedCoursesParams,
    sql: SUGGESTED_COURSES_SQL,
    configParamNames: ['department'],
  },
};
