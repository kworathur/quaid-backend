/**
 * CloudFormation Custom Resource Lambda — DegreeWorks DB Setup
 *
 * Runs schema.sql then seed.sql against the Aurora Serverless v2 cluster via
 * the RDS Data API.  Both files use IF NOT EXISTS / ON CONFLICT DO NOTHING so
 * the function is safe to run on every deployment (idempotent).
 *
 * SQL is embedded as inline strings to be compatible with esbuild bundling.
 *
 * CloudFormation lifecycle:
 *   Create  → run schema + seed
 *   Update  → run schema + seed (idempotent, no harm)
 *   Delete  → no-op (data is retained)
 */
import * as https from 'https';
import * as url from 'url';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

const rdsData = new RDSDataClient({});

const CLUSTER_ARN = process.env.DEGREE_WORKS_CLUSTER_ARN!;
const SECRET_ARN = process.env.DEGREE_WORKS_SECRET_ARN!;
const DB_NAME = process.env.DEGREE_WORKS_DB_NAME!;

// ── Embedded SQL ─────────────────────────────────────────────────────────────
// Kept inline so esbuild can bundle the Lambda without needing to copy .sql files.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS programs (
  program_id             SERIAL PRIMARY KEY,
  program_code           VARCHAR(20)  UNIQUE NOT NULL,
  program_name           VARCHAR(200) NOT NULL,
  degree_type            VARCHAR(20)  NOT NULL,
  total_credits_required INT          NOT NULL,
  department             VARCHAR(100),
  is_active              BOOLEAN DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS courses (
  course_id     SERIAL PRIMARY KEY,
  subject_code  VARCHAR(10)  NOT NULL,
  course_number VARCHAR(10)  NOT NULL,
  course_name   VARCHAR(200) NOT NULL,
  credit_hours  NUMERIC(3,1) NOT NULL,
  description   TEXT,
  is_active     BOOLEAN DEFAULT TRUE,
  UNIQUE(subject_code, course_number)
);
CREATE TABLE IF NOT EXISTS course_attributes (
  attribute_id   SERIAL PRIMARY KEY,
  course_id      INT REFERENCES courses(course_id),
  attribute_code VARCHAR(50)  NOT NULL,
  attribute_name VARCHAR(100)
);
CREATE TABLE IF NOT EXISTS degree_requirements (
  req_id        SERIAL PRIMARY KEY,
  program_id    INT REFERENCES programs(program_id),
  req_type      VARCHAR(50)  NOT NULL,
  req_name      VARCHAR(200),
  subject_code  VARCHAR(10),
  course_number VARCHAR(10),
  attribute_code VARCHAR(50),
  min_credits   NUMERIC(5,1),
  min_grade     VARCHAR(5)
);
CREATE TABLE IF NOT EXISTS student_programs (
  sp_id               SERIAL PRIMARY KEY,
  student_id          INT NOT NULL,
  program_id          INT REFERENCES programs(program_id),
  declared_date       DATE,
  is_active           BOOLEAN DEFAULT TRUE,
  expected_graduation DATE
);
CREATE TABLE IF NOT EXISTS student_courses (
  sc_id          SERIAL PRIMARY KEY,
  student_id     INT NOT NULL,
  subject_code   VARCHAR(10) NOT NULL,
  course_number  VARCHAR(10) NOT NULL,
  course_id      INT REFERENCES courses(course_id),
  term_code      VARCHAR(10),
  grade          VARCHAR(5),
  credits_earned NUMERIC(3,1),
  status         VARCHAR(20) NOT NULL
);
CREATE TABLE IF NOT EXISTS student_gpa (
  gpa_id                  SERIAL PRIMARY KEY,
  student_id              INT NOT NULL,
  term_code               VARCHAR(10),
  gpa                     NUMERIC(4,3),
  total_credits_attempted NUMERIC(5,1),
  total_credits_earned    NUMERIC(5,1),
  UNIQUE(student_id, term_code)
);
CREATE TABLE IF NOT EXISTS scholarships (
  scholarship_id   SERIAL PRIMARY KEY,
  scholarship_code VARCHAR(50)  UNIQUE NOT NULL,
  scholarship_name VARCHAR(200) NOT NULL,
  description      TEXT,
  is_active        BOOLEAN DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS scholarship_rules (
  rule_id        SERIAL PRIMARY KEY,
  scholarship_id INT REFERENCES scholarships(scholarship_id),
  rule_type      VARCHAR(50)  NOT NULL,
  rule_operator  VARCHAR(10)  NOT NULL,
  rule_value     NUMERIC(8,2) NOT NULL,
  disqualifies   BOOLEAN DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS student_scholarships (
  ss_id          SERIAL PRIMARY KEY,
  student_id     INT NOT NULL,
  scholarship_id INT REFERENCES scholarships(scholarship_id),
  status         VARCHAR(30) NOT NULL,
  term_code      VARCHAR(10),
  reason         TEXT
);
CREATE TABLE IF NOT EXISTS student_attendance (
  att_id          SERIAL PRIMARY KEY,
  student_id      INT NOT NULL,
  subject_code    VARCHAR(10) NOT NULL,
  course_number   VARCHAR(10) NOT NULL,
  term_code       VARCHAR(10) NOT NULL,
  attendance_rate NUMERIC(5,2),
  absences        INT
)
`.trim();

const SEED_SQL = `
INSERT INTO programs (program_code, program_name, degree_type, total_credits_required, department)
VALUES
  ('CS-BS',  'Bachelor of Science in Computer Science',     'BACHELORS', 120, 'Computer Science'),
  ('BUS-BA', 'Bachelor of Arts in Business Administration', 'BACHELORS', 120, 'Business'),
  ('MATH-BS','Bachelor of Science in Mathematics',          'BACHELORS', 120, 'Mathematics')
ON CONFLICT (program_code) DO NOTHING;
INSERT INTO courses (subject_code, course_number, course_name, credit_hours, description)
VALUES
  ('CSCI','1301','Introduction to Computing',3.0,'Fundamentals of computing and programming'),
  ('CSCI','1302','Software Development',3.0,'OOP principles and software engineering'),
  ('CSCI','2150','Systems Programming',3.0,'C programming, memory management, OS interfaces'),
  ('CSCI','2720','Data Structures',3.0,'Arrays, linked lists, trees, graphs, sorting'),
  ('CSCI','3360','Artificial Intelligence',3.0,'Search, knowledge representation, ML basics'),
  ('CSCI','4150','Algorithms',3.0,'Algorithm design, complexity, NP-completeness'),
  ('CSCI','4370','Database Management',3.0,'Relational model, SQL, transactions, indexing'),
  ('CSCI','4720','Operating Systems',3.0,'Processes, memory, file systems, concurrency'),
  ('MATH','2200','Calculus I',4.0,'Limits, derivatives, integrals'),
  ('MATH','2210','Calculus II',4.0,'Integration techniques, series, polar coordinates'),
  ('MATH','3000','Discrete Mathematics',3.0,'Logic, sets, combinatorics, graph theory'),
  ('MATH','3200','Linear Algebra',3.0,'Vectors, matrices, eigenvalues'),
  ('MATH','3600','Probability and Statistics',3.0,'Probability distributions, inference'),
  ('MATH','4000','Abstract Algebra',3.0,'Groups, rings, fields'),
  ('MATH','4200','Real Analysis',3.0,'Rigorous calculus, metric spaces'),
  ('ENGL','1101','English Composition I',3.0,'Academic writing and rhetoric'),
  ('ENGL','1102','English Composition II',3.0,'Research writing and argumentation'),
  ('BUS','2000','Principles of Management',3.0,'Management theory and practice'),
  ('BUS','2100','Financial Accounting',3.0,'Balance sheets, income statements, cash flow'),
  ('BUS','2200','Marketing Fundamentals',3.0,'Market analysis, consumer behaviour'),
  ('BUS','3100','Corporate Finance',3.0,'Capital structure, valuation, risk'),
  ('BUS','3200','Business Law',3.0,'Contract, tort, and commercial law'),
  ('BUS','4100','Strategic Management',3.0,'Competitive strategy and execution'),
  ('BUS','4200','Operations Management',3.0,'Supply chain, quality, process design')
ON CONFLICT (subject_code, course_number) DO NOTHING;
INSERT INTO degree_requirements (program_id, req_type, req_name, subject_code, course_number, min_credits, min_grade)
SELECT p.program_id, 'SPECIFIC_COURSE', c.course_name, c.subject_code, c.course_number, c.credit_hours, 'C'
FROM programs p, courses c
WHERE p.program_code = 'CS-BS'
  AND (c.subject_code = 'CSCI'
       OR (c.subject_code = 'MATH' AND c.course_number IN ('2200','2210','3000','3200'))
       OR (c.subject_code = 'ENGL' AND c.course_number IN ('1101','1102')));
INSERT INTO degree_requirements (program_id, req_type, req_name, subject_code, course_number, min_credits, min_grade)
SELECT p.program_id, 'SPECIFIC_COURSE', c.course_name, c.subject_code, c.course_number, c.credit_hours, 'C'
FROM programs p, courses c
WHERE p.program_code = 'MATH-BS'
  AND (c.subject_code = 'MATH' OR (c.subject_code = 'ENGL' AND c.course_number IN ('1101','1102')));
INSERT INTO degree_requirements (program_id, req_type, req_name, subject_code, course_number, min_credits, min_grade)
SELECT p.program_id, 'SPECIFIC_COURSE', c.course_name, c.subject_code, c.course_number, c.credit_hours, 'C'
FROM programs p, courses c
WHERE p.program_code = 'BUS-BA'
  AND (c.subject_code = 'BUS' OR (c.subject_code = 'ENGL' AND c.course_number IN ('1101','1102')));
INSERT INTO student_programs (student_id, program_id, declared_date, is_active, expected_graduation)
SELECT s.sid, p.program_id, '2022-08-15', TRUE,
  CASE WHEN s.sid <= 5 THEN DATE '2026-05-10' WHEN s.sid <= 8 THEN DATE '2025-12-15' ELSE DATE '2026-05-10' END
FROM (VALUES (1),(2),(3),(4),(5)) AS s(sid),
     (SELECT program_id FROM programs WHERE program_code = 'CS-BS') AS p;
INSERT INTO student_programs (student_id, program_id, declared_date, is_active, expected_graduation)
SELECT s.sid, p.program_id, '2022-08-15', TRUE, '2025-12-15'
FROM (VALUES (6),(7),(8)) AS s(sid),
     (SELECT program_id FROM programs WHERE program_code = 'BUS-BA') AS p;
INSERT INTO student_programs (student_id, program_id, declared_date, is_active, expected_graduation)
SELECT s.sid, p.program_id, '2023-01-10', TRUE, '2026-05-10'
FROM (VALUES (9),(10)) AS s(sid),
     (SELECT program_id FROM programs WHERE program_code = 'MATH-BS') AS p;
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT 1, c.subject_code, c.course_number, c.course_id, '202301', 'A', c.credit_hours, 'COMPLETED'
FROM courses c WHERE c.subject_code = 'MATH' AND c.course_number IN ('2200','2210','3000','3200','3600');
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT 2, c.subject_code, c.course_number, c.course_id, '202301', 'B', c.credit_hours, 'COMPLETED'
FROM courses c WHERE c.subject_code = 'MATH' AND c.course_number IN ('2200','2210','3000','3200','3600','4000');
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT 3, c.subject_code, c.course_number, c.course_id, '202301', 'A', c.credit_hours, 'COMPLETED'
FROM courses c WHERE c.subject_code IN ('MATH','ENGL');
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT sid, c.subject_code, c.course_number, c.course_id, '202302', 'B', c.credit_hours, 'COMPLETED'
FROM (VALUES (1),(2),(3)) AS s(sid), courses c
WHERE c.subject_code IN ('CSCI','ENGL');
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT sid, c.subject_code, c.course_number, c.course_id, '202302', 'C', c.credit_hours, 'COMPLETED'
FROM (VALUES (4),(5)) AS s(sid), courses c
WHERE c.subject_code = 'CSCI' AND c.course_number IN ('1301','1302','2150','2720');
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT sid, c.subject_code, c.course_number, c.course_id, '202401', 'B', c.credit_hours, 'COMPLETED'
FROM (VALUES (6),(7),(8)) AS s(sid), courses c
WHERE c.subject_code IN ('BUS','ENGL');
INSERT INTO student_courses (student_id, subject_code, course_number, course_id, term_code, grade, credits_earned, status)
SELECT sid, c.subject_code, c.course_number, c.course_id, '202401', 'A', c.credit_hours, 'COMPLETED'
FROM (VALUES (9),(10)) AS s(sid), courses c
WHERE c.subject_code IN ('MATH','ENGL');
INSERT INTO student_gpa (student_id, term_code, gpa, total_credits_attempted, total_credits_earned)
VALUES
  (1,NULL,3.85,90,90),(2,NULL,3.50,96,96),(3,NULL,3.90,120,120),
  (4,NULL,2.95,60,60),(5,NULL,3.05,60,60),(6,NULL,3.20,110,110),
  (7,NULL,3.10,100,100),(8,NULL,2.80,90,88),(9,NULL,3.75,80,80),(10,NULL,4.00,60,60)
ON CONFLICT (student_id, term_code) DO NOTHING;
INSERT INTO scholarships (scholarship_code, scholarship_name, description)
VALUES
  ('ZELL_MILLER','Zell Miller Scholarship','Full tuition scholarship for Georgia residents. Requires min 3.0 GPA and 127 credit hours.'),
  ('HOPE','HOPE Scholarship','Lottery-funded scholarship. Requires min 3.0 cumulative GPA.'),
  ('PELL','Pell Grant','Federal need-based grant. Attendance rate must be >= 67%.')
ON CONFLICT (scholarship_code) DO NOTHING;
INSERT INTO scholarship_rules (scholarship_id, rule_type, rule_operator, rule_value, disqualifies)
SELECT s.scholarship_id,'MIN_GPA','GTE',3.0,FALSE FROM scholarships s WHERE s.scholarship_code='ZELL_MILLER';
INSERT INTO scholarship_rules (scholarship_id, rule_type, rule_operator, rule_value, disqualifies)
SELECT s.scholarship_id,'MAX_CREDITS','LTE',127,FALSE FROM scholarships s WHERE s.scholarship_code='ZELL_MILLER';
INSERT INTO scholarship_rules (scholarship_id, rule_type, rule_operator, rule_value, disqualifies)
SELECT s.scholarship_id,'MIN_GPA','GTE',3.0,FALSE FROM scholarships s WHERE s.scholarship_code='HOPE';
INSERT INTO scholarship_rules (scholarship_id, rule_type, rule_operator, rule_value, disqualifies)
SELECT s.scholarship_id,'ENROLLMENT_STATUS','GTE',67,FALSE FROM scholarships s WHERE s.scholarship_code='PELL';
INSERT INTO student_scholarships (student_id, scholarship_id, status, term_code, reason)
SELECT s.sid, sch.scholarship_id,
  CASE WHEN s.gpa>=3.0 AND s.credits<=127 THEN 'ELIGIBLE'
       WHEN s.gpa>=3.0 AND s.credits>127  THEN 'INELIGIBLE'
       ELSE 'INELIGIBLE' END,
  '202501',
  CASE WHEN s.gpa<3.0 THEN 'GPA below 3.0 minimum'
       WHEN s.credits>127 THEN 'Exceeds 127 credit hour limit' ELSE NULL END
FROM (VALUES(1,3.85,90),(2,3.50,96),(3,3.90,120),(4,2.95,60),(5,3.05,60),
            (6,3.20,110),(7,3.10,100),(8,2.80,90),(9,3.75,80),(10,4.00,60)) AS s(sid,gpa,credits),
scholarships sch WHERE sch.scholarship_code='ZELL_MILLER';
INSERT INTO student_scholarships (student_id, scholarship_id, status, term_code, reason)
SELECT s.sid, sch.scholarship_id,
  CASE WHEN s.gpa>=3.0 THEN 'ELIGIBLE' ELSE 'INELIGIBLE' END,
  '202501',
  CASE WHEN s.gpa<3.0 THEN 'GPA below 3.0 minimum' ELSE NULL END
FROM (VALUES(1,3.85),(2,3.50),(3,3.90),(4,2.95),(5,3.05),
            (6,3.20),(7,3.10),(8,2.80),(9,3.75),(10,4.00)) AS s(sid,gpa),
scholarships sch WHERE sch.scholarship_code='HOPE';
INSERT INTO student_scholarships (student_id, scholarship_id, status, term_code, reason)
SELECT s.sid,sch.scholarship_id,'ELIGIBLE','202501',NULL
FROM (VALUES(1),(2),(3),(4),(5),(6),(7),(8),(9),(10)) AS s(sid),
scholarships sch WHERE sch.scholarship_code='PELL';
INSERT INTO student_attendance (student_id, subject_code, course_number, term_code, attendance_rate, absences)
VALUES
  (7,'BUS','4100','202501',60.0,8),(8,'BUS','4200','202501',55.0,9),(9,'MATH','4000','202501',62.0,7),
  (1,'CSCI','4150','202501',95.0,1),(2,'CSCI','4370','202501',90.0,2),(3,'CSCI','4720','202501',98.0,0),
  (4,'CSCI','2720','202501',85.0,3),(5,'CSCI','2720','202501',88.0,2),
  (6,'BUS','4100','202501',92.0,1),(10,'MATH','4200','202501',97.0,0)
`.trim();

// ── CloudFormation helpers ───────────────────────────────────────────────────

interface CloudFormationEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
}

interface CloudFormationContext {
  logStreamName: string;
}

function sendResponse(
  event: CloudFormationEvent,
  context: CloudFormationContext,
  status: 'SUCCESS' | 'FAILED',
  reason?: string,
): Promise<void> {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: reason ?? `See CloudWatch log stream: ${context.logStreamName}`,
    PhysicalResourceId: event.PhysicalResourceId ?? context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  });

  const parsedUrl = url.parse(event.ResponseURL);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: 'PUT',
    headers: {
      'Content-Type': '',
      'Content-Length': Buffer.byteLength(responseBody),
    },
  };

  return new Promise((resolve, reject) => {
    const request = https.request(options, () => resolve());
    request.on('error', reject);
    request.write(responseBody);
    request.end();
  });
}

async function runSqlStatements(sql: string): Promise<void> {
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const statement of statements) {
    console.info('Executing:', statement.substring(0, 120).replace(/\s+/g, ' '));
    await rdsData.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DB_NAME,
        sql: statement,
      }),
    );
  }
}

export const handler = async (
  event: CloudFormationEvent,
  context: CloudFormationContext,
): Promise<void> => {
  console.info('Custom resource event:', JSON.stringify(event));

  if (event.RequestType === 'Delete') {
    await sendResponse(event, context, 'SUCCESS');
    return;
  }

  try {
    console.info('Running schema SQL...');
    await runSqlStatements(SCHEMA_SQL);

    console.info('Running seed SQL...');
    await runSqlStatements(SEED_SQL);

    console.info('DegreeWorks setup complete.');
    await sendResponse(event, context, 'SUCCESS');
  } catch (err) {
    console.error('Setup failed:', err);
    await sendResponse(
      event,
      context,
      'FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }
};
