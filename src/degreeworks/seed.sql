-- DegreeWorks seed data
-- Uses ON CONFLICT DO NOTHING for idempotency.

-- ── Programs ──────────────────────────────────────────────────────────────────
INSERT INTO programs (program_code, program_name, degree_type, total_credits_required, department)
VALUES
  ('CS-BS',  'Bachelor of Science in Computer Science',      'BACHELORS', 120, 'Computer Science'),
  ('BUS-BA', 'Bachelor of Arts in Business Administration',  'BACHELORS', 120, 'Business'),
  ('MATH-BS','Bachelor of Science in Mathematics',           'BACHELORS', 120, 'Mathematics')
ON CONFLICT (program_code) DO NOTHING;

-- ── Courses ───────────────────────────────────────────────────────────────────
INSERT INTO courses (subject_code, course_number, course_name, credit_hours, description)
VALUES
  -- CSCI core
  ('CSCI','1301','Introduction to Computing',             3.0, 'Fundamentals of computing and programming'),
  ('CSCI','1302','Software Development',                  3.0, 'OOP principles and software engineering'),
  ('CSCI','2150','Systems Programming',                   3.0, 'C programming, memory management, OS interfaces'),
  ('CSCI','2720','Data Structures',                       3.0, 'Arrays, linked lists, trees, graphs, sorting'),
  ('CSCI','3360','Artificial Intelligence',               3.0, 'Search, knowledge representation, ML basics'),
  ('CSCI','4150','Algorithms',                            3.0, 'Algorithm design, complexity, NP-completeness'),
  ('CSCI','4370','Database Management',                   3.0, 'Relational model, SQL, transactions, indexing'),
  ('CSCI','4720','Operating Systems',                     3.0, 'Processes, memory, file systems, concurrency'),
  -- MATH core
  ('MATH','2200','Calculus I',                            4.0, 'Limits, derivatives, integrals'),
  ('MATH','2210','Calculus II',                           4.0, 'Integration techniques, series, polar coordinates'),
  ('MATH','3000','Discrete Mathematics',                  3.0, 'Logic, sets, combinatorics, graph theory'),
  ('MATH','3200','Linear Algebra',                        3.0, 'Vectors, matrices, eigenvalues'),
  ('MATH','3600','Probability and Statistics',            3.0, 'Probability distributions, inference'),
  ('MATH','4000','Abstract Algebra',                      3.0, 'Groups, rings, fields'),
  ('MATH','4200','Real Analysis',                         3.0, 'Rigorous calculus, metric spaces'),
  -- ENGL core
  ('ENGL','1101','English Composition I',                 3.0, 'Academic writing and rhetoric'),
  ('ENGL','1102','English Composition II',                3.0, 'Research writing and argumentation'),
  -- BUS core
  ('BUS', '2000','Principles of Management',              3.0, 'Management theory and practice'),
  ('BUS', '2100','Financial Accounting',                  3.0, 'Balance sheets, income statements, cash flow'),
  ('BUS', '2200','Marketing Fundamentals',                3.0, 'Market analysis, consumer behaviour'),
  ('BUS', '3100','Corporate Finance',                     3.0, 'Capital structure, valuation, risk'),
  ('BUS', '3200','Business Law',                          3.0, 'Contract, tort, and commercial law'),
  ('BUS', '4100','Strategic Management',                  3.0, 'Competitive strategy and execution'),
  ('BUS', '4200','Operations Management',                 3.0, 'Supply chain, quality, process design')
ON CONFLICT (subject_code, course_number) DO NOTHING;

-- ── Degree Requirements: CS-BS (program_id = 1) ───────────────────────────────
INSERT INTO degree_requirements (program_id, req_type, req_name, subject_code, course_number, min_credits, min_grade)
SELECT p.program_id, 'SPECIFIC_COURSE', c.course_name, c.subject_code, c.course_number, c.credit_hours, 'C'
FROM programs p, courses c
WHERE p.program_code = 'CS-BS'
  AND (c.subject_code = 'CSCI' OR (c.subject_code = 'MATH' AND c.course_number IN ('2200','2210','3000','3200'))
       OR (c.subject_code = 'ENGL' AND c.course_number IN ('1101','1102')))
ON CONFLICT DO NOTHING;

-- ── Degree Requirements: MATH-BS (program_id = 3) ────────────────────────────
INSERT INTO degree_requirements (program_id, req_type, req_name, subject_code, course_number, min_credits, min_grade)
SELECT p.program_id, 'SPECIFIC_COURSE', c.course_name, c.subject_code, c.course_number, c.credit_hours, 'C'
FROM programs p, courses c
WHERE p.program_code = 'MATH-BS'
  AND (c.subject_code = 'MATH' OR (c.subject_code = 'ENGL' AND c.course_number IN ('1101','1102')))
ON CONFLICT DO NOTHING;

-- ── Degree Requirements: BUS-BA (program_id = 2) ─────────────────────────────
INSERT INTO degree_requirements (program_id, req_type, req_name, subject_code, course_number, min_credits, min_grade)
SELECT p.program_id, 'SPECIFIC_COURSE', c.course_name, c.subject_code, c.course_number, c.credit_hours, 'C'
FROM programs p, courses c
WHERE p.program_code = 'BUS-BA'
  AND (c.subject_code = 'BUS' OR (c.subject_code = 'ENGL' AND c.course_number IN ('1101','1102')))
ON CONFLICT DO NOTHING;

-- ── Student Programs (declared majors) ───────────────────────────────────────
-- Students 1-5: CS-BS  |  Students 6-8: BUS-BA  |  Student 9-10: MATH-BS
INSERT INTO student_programs (student_id, program_id, declared_date, is_active, expected_graduation)
SELECT s.sid, p.program_id, '2022-08-15', TRUE,
       CASE WHEN s.sid <= 5 THEN DATE '2026-05-10'
            WHEN s.sid <= 8 THEN DATE '2025-12-15'
            ELSE DATE '2026-05-10' END
FROM (VALUES (1),(2),(3),(4),(5)) AS s(sid),
     (SELECT program_id FROM programs WHERE program_code = 'CS-BS') AS p
ON CONFLICT DO NOTHING;

INSERT INTO student_programs (student_id, program_id, declared_date, is_active, expected_graduation)
SELECT s.sid, p.program_id, '2022-08-15', TRUE, '2025-12-15'
FROM (VALUES (6),(7),(8)) AS s(sid),
     (SELECT program_id FROM programs WHERE program_code = 'BUS-BA') AS p
ON CONFLICT DO NOTHING;

INSERT INTO student_programs (student_id, program_id, declared_date, is_active, expected_graduation)
SELECT s.sid, p.program_id, '2023-01-10', TRUE, '2026-05-10'
FROM (VALUES (9),(10)) AS s(sid),
     (SELECT program_id FROM programs WHERE program_code = 'MATH-BS') AS p
ON CONFLICT DO NOTHING;

-- ── Student Transcripts ───────────────────────────────────────────────────────
-- Students 1-3: CS majors who have completed nearly all MATH-BS requirements
--               (making them candidates for the CREDENTIALS_NEAR_COMPLETION insight)
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT 1, c.subject_code, c.course_number, c.course_id, '202301', 'A', c.credit_hours, 'COMPLETED'
FROM courses c WHERE c.subject_code = 'MATH' AND c.course_number IN ('2200','2210','3000','3200','3600')
ON CONFLICT DO NOTHING;

INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT 2, c.subject_code, c.course_number, c.course_id, '202301', 'B', c.credit_hours, 'COMPLETED'
FROM courses c WHERE c.subject_code = 'MATH' AND c.course_number IN ('2200','2210','3000','3200','3600','4000')
ON CONFLICT DO NOTHING;

INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT 3, c.subject_code, c.course_number, c.course_id, '202301', 'A', c.credit_hours, 'COMPLETED'
FROM courses c WHERE c.subject_code IN ('MATH','ENGL')
ON CONFLICT DO NOTHING;

-- All three also completed CSCI and ENGL requirements for their declared CS-BS
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT sid, c.subject_code, c.course_number, c.course_id, '202302', 'B', c.credit_hours, 'COMPLETED'
FROM (VALUES (1),(2),(3)) AS s(sid), courses c
WHERE c.subject_code IN ('CSCI','ENGL')
ON CONFLICT DO NOTHING;

-- Students 4-5: CS majors, completed most core CSCI but skipping advanced math
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT sid, c.subject_code, c.course_number, c.course_id, '202302', 'C', c.credit_hours, 'COMPLETED'
FROM (VALUES (4),(5)) AS s(sid), courses c
WHERE c.subject_code = 'CSCI' AND c.course_number IN ('1301','1302','2150','2720')
ON CONFLICT DO NOTHING;

-- Students 6-8: BUS majors
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT sid, c.subject_code, c.course_number, c.course_id, '202401', 'B', c.credit_hours, 'COMPLETED'
FROM (VALUES (6),(7),(8)) AS s(sid), courses c
WHERE c.subject_code IN ('BUS','ENGL')
ON CONFLICT DO NOTHING;

-- Students 9-10: MATH majors (clean records for control)
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT sid, c.subject_code, c.course_number, c.course_id, '202401', 'A', c.credit_hours, 'COMPLETED'
FROM (VALUES (9),(10)) AS s(sid), courses c
WHERE c.subject_code IN ('MATH','ENGL')
ON CONFLICT DO NOTHING;

-- ── GPA Records ───────────────────────────────────────────────────────────────
-- Cumulative (term_code = NULL handled as unique via (student_id, term_code) — use '' as term sentinel
INSERT INTO student_gpa (student_id, term_code, gpa, total_credits_attempted, total_credits_earned)
VALUES
  (1,  NULL, 3.85, 90,  90),
  (2,  NULL, 3.50, 96,  96),
  (3,  NULL, 3.90, 120, 120),
  (4,  NULL, 2.95, 60,  60),   -- at risk for Zell Miller (< 3.0)
  (5,  NULL, 3.05, 60,  60),   -- just above threshold
  (6,  NULL, 3.20, 110, 110),
  (7,  NULL, 3.10, 100, 100),
  (8,  NULL, 2.80, 90,  88),   -- below GPA threshold
  (9,  NULL, 3.75, 80,  80),
  (10, NULL, 4.00, 60,  60)
ON CONFLICT (student_id, term_code) DO NOTHING;

-- ── Scholarships ─────────────────────────────────────────────────────────────
INSERT INTO scholarships (scholarship_code, scholarship_name, description)
VALUES
  ('ZELL_MILLER', 'Zell Miller Scholarship',
   'Full tuition scholarship for Georgia residents with high academic achievement. Requires minimum 3.0 GPA and ≤127 credit hours.'),
  ('HOPE',        'HOPE Scholarship',
   'Lottery-funded scholarship for Georgia residents. Requires minimum 3.0 cumulative GPA.'),
  ('PELL',        'Pell Grant',
   'Federal need-based grant. Attendance rate must be ≥ 67%.')
ON CONFLICT (scholarship_code) DO NOTHING;

-- ── Scholarship Rules ─────────────────────────────────────────────────────────
-- Zell Miller: min GPA 3.0, max 127 credit hours
INSERT INTO scholarship_rules (scholarship_id, rule_type, rule_operator, rule_value, disqualifies)
SELECT s.scholarship_id, 'MIN_GPA', 'GTE', 3.0, FALSE
FROM scholarships s WHERE s.scholarship_code = 'ZELL_MILLER'
ON CONFLICT DO NOTHING;

INSERT INTO scholarship_rules (scholarship_id, rule_type, rule_operator, rule_value, disqualifies)
SELECT s.scholarship_id, 'MAX_CREDITS', 'LTE', 127, FALSE
FROM scholarships s WHERE s.scholarship_code = 'ZELL_MILLER'
ON CONFLICT DO NOTHING;

-- HOPE: min GPA 3.0
INSERT INTO scholarship_rules (scholarship_id, rule_type, rule_operator, rule_value, disqualifies)
SELECT s.scholarship_id, 'MIN_GPA', 'GTE', 3.0, FALSE
FROM scholarships s WHERE s.scholarship_code = 'HOPE'
ON CONFLICT DO NOTHING;

-- Pell: attendance rate >= 67% (any lower disqualifies)
INSERT INTO scholarship_rules (scholarship_id, rule_type, rule_operator, rule_value, disqualifies)
SELECT s.scholarship_id, 'ENROLLMENT_STATUS', 'GTE', 67, FALSE
FROM scholarships s WHERE s.scholarship_code = 'PELL'
ON CONFLICT DO NOTHING;

-- ── Student Scholarship Eligibility ──────────────────────────────────────────
-- Zell Miller
INSERT INTO student_scholarships (student_id, scholarship_id, status, term_code, reason)
SELECT s.sid, sch.scholarship_id,
  CASE WHEN s.gpa >= 3.0 AND s.credits <= 127 THEN 'ELIGIBLE'
       WHEN s.gpa >= 3.0 AND s.credits > 127   THEN 'INELIGIBLE'
       ELSE 'INELIGIBLE' END,
  '202501',
  CASE WHEN s.gpa < 3.0 THEN 'GPA below 3.0 minimum'
       WHEN s.credits > 127 THEN 'Exceeds 127 credit hour limit'
       ELSE NULL END
FROM (VALUES
  (1, 3.85, 90), (2, 3.50, 96), (3, 3.90, 120), (4, 2.95, 60),
  (5, 3.05, 60), (6, 3.20, 110),(7, 3.10, 100), (8, 2.80, 90),
  (9, 3.75, 80), (10,4.00, 60)
) AS s(sid, gpa, credits),
scholarships sch
WHERE sch.scholarship_code = 'ZELL_MILLER'
ON CONFLICT DO NOTHING;

-- HOPE
INSERT INTO student_scholarships (student_id, scholarship_id, status, term_code, reason)
SELECT s.sid, sch.scholarship_id,
  CASE WHEN s.gpa >= 3.0 THEN 'ELIGIBLE' ELSE 'INELIGIBLE' END,
  '202501',
  CASE WHEN s.gpa < 3.0 THEN 'GPA below 3.0 minimum' ELSE NULL END
FROM (VALUES
  (1, 3.85), (2, 3.50), (3, 3.90), (4, 2.95),
  (5, 3.05), (6, 3.20), (7, 3.10), (8, 2.80),
  (9, 3.75), (10,4.00)
) AS s(sid, gpa),
scholarships sch
WHERE sch.scholarship_code = 'HOPE'
ON CONFLICT DO NOTHING;

-- Pell (all eligible by default in seed — attendance data provided separately)
INSERT INTO student_scholarships (student_id, scholarship_id, status, term_code, reason)
SELECT s.sid, sch.scholarship_id, 'ELIGIBLE', '202501', NULL
FROM (VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10)) AS s(sid),
scholarships sch
WHERE sch.scholarship_code = 'PELL'
ON CONFLICT DO NOTHING;

-- ── Attendance Records ────────────────────────────────────────────────────────
-- Students 7-9: attendance risk for Pell (<67%)
INSERT INTO student_attendance (student_id, subject_code, course_number, term_code, attendance_rate, absences)
VALUES
  (7,  'BUS', '4100', '202501', 60.0, 8),
  (8,  'BUS', '4200', '202501', 55.0, 9),
  (9,  'MATH','4000', '202501', 62.0, 7),
  -- Healthy attendance for others
  (1,  'CSCI','4150', '202501', 95.0, 1),
  (2,  'CSCI','4370', '202501', 90.0, 2),
  (3,  'CSCI','4720', '202501', 98.0, 0),
  (4,  'CSCI','2720', '202501', 85.0, 3),
  (5,  'CSCI','2720', '202501', 88.0, 2),
  (6,  'BUS', '4100', '202501', 92.0, 1),
  (10, 'MATH','4200', '202501', 97.0, 0)
ON CONFLICT DO NOTHING;
