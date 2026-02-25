-- DegreeWorks clone schema (PostgreSQL / Aurora Serverless v2)
-- All statements use CREATE TABLE IF NOT EXISTS for idempotency.

-- Degree programs (e.g., B.S. Computer Science)
CREATE TABLE IF NOT EXISTS programs (
  program_id             SERIAL PRIMARY KEY,
  program_code           VARCHAR(20)  UNIQUE NOT NULL,
  program_name           VARCHAR(200) NOT NULL,
  degree_type            VARCHAR(20)  NOT NULL,  -- 'BACHELORS' | 'MASTERS' | 'DOCTORAL'
  total_credits_required INT          NOT NULL,
  department             VARCHAR(100),
  is_active              BOOLEAN DEFAULT TRUE
);

-- Course catalog
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

-- Course attributes (marks a course as fulfilling a requirement type)
CREATE TABLE IF NOT EXISTS course_attributes (
  attribute_id   SERIAL PRIMARY KEY,
  course_id      INT REFERENCES courses(course_id),
  attribute_code VARCHAR(50)  NOT NULL,  -- 'CORE' | 'ELECTIVE' | 'GEN_ED' | 'WRITING_INTENSIVE'
  attribute_name VARCHAR(100)
);

-- What courses/credits are required for each program
CREATE TABLE IF NOT EXISTS degree_requirements (
  req_id        SERIAL PRIMARY KEY,
  program_id    INT REFERENCES programs(program_id),
  req_type      VARCHAR(50)  NOT NULL,  -- 'SPECIFIC_COURSE' | 'CREDIT_HOURS' | 'ATTRIBUTE_HOURS'
  req_name      VARCHAR(200),
  subject_code  VARCHAR(10),            -- for SPECIFIC_COURSE
  course_number VARCHAR(10),            -- for SPECIFIC_COURSE
  attribute_code VARCHAR(50),           -- for ATTRIBUTE_HOURS
  min_credits   NUMERIC(5,1),
  min_grade     VARCHAR(5)              -- e.g., 'C', 'D'
);

-- Which programs a student is pursuing
CREATE TABLE IF NOT EXISTS student_programs (
  sp_id               SERIAL PRIMARY KEY,
  student_id          INT NOT NULL,
  program_id          INT REFERENCES programs(program_id),
  declared_date       DATE,
  is_active           BOOLEAN DEFAULT TRUE,
  expected_graduation DATE
);

-- Student transcript
CREATE TABLE IF NOT EXISTS student_courses (
  sc_id          SERIAL PRIMARY KEY,
  student_id     INT NOT NULL,
  subject_code   VARCHAR(10) NOT NULL,
  course_number  VARCHAR(10) NOT NULL,
  course_id      INT REFERENCES courses(course_id),
  term_code      VARCHAR(10),
  grade          VARCHAR(5),
  credits_earned NUMERIC(3,1),
  status         VARCHAR(20) NOT NULL   -- 'COMPLETED' | 'IN_PROGRESS' | 'WITHDRAWN' | 'TRANSFER'
);

-- Cumulative and per-term GPA
CREATE TABLE IF NOT EXISTS student_gpa (
  gpa_id                  SERIAL PRIMARY KEY,
  student_id              INT NOT NULL,
  term_code               VARCHAR(10),
  gpa                     NUMERIC(4,3),
  total_credits_attempted NUMERIC(5,1),
  total_credits_earned    NUMERIC(5,1),
  UNIQUE(student_id, term_code)
);

-- Scholarship catalog
CREATE TABLE IF NOT EXISTS scholarships (
  scholarship_id   SERIAL PRIMARY KEY,
  scholarship_code VARCHAR(50)  UNIQUE NOT NULL,
  scholarship_name VARCHAR(200) NOT NULL,
  description      TEXT,
  is_active        BOOLEAN DEFAULT TRUE
);

-- Rules that qualify or disqualify a student for a scholarship
CREATE TABLE IF NOT EXISTS scholarship_rules (
  rule_id        SERIAL PRIMARY KEY,
  scholarship_id INT REFERENCES scholarships(scholarship_id),
  rule_type      VARCHAR(50)  NOT NULL,   -- 'MIN_GPA' | 'MAX_CREDITS' | 'MIN_CREDITS' | 'ENROLLMENT_STATUS'
  rule_operator  VARCHAR(10)  NOT NULL,   -- 'GTE' | 'LTE' | 'EQ' | 'GT' | 'LT'
  rule_value     NUMERIC(8,2) NOT NULL,
  disqualifies   BOOLEAN DEFAULT FALSE
);

-- Per-student scholarship eligibility (computed/cached)
CREATE TABLE IF NOT EXISTS student_scholarships (
  ss_id          SERIAL PRIMARY KEY,
  student_id     INT NOT NULL,
  scholarship_id INT REFERENCES scholarships(scholarship_id),
  status         VARCHAR(30) NOT NULL,    -- 'ELIGIBLE' | 'INELIGIBLE' | 'AT_RISK' | 'AWARDED'
  term_code      VARCHAR(10),
  reason         TEXT
);

-- Attendance records per course per term
CREATE TABLE IF NOT EXISTS student_attendance (
  att_id          SERIAL PRIMARY KEY,
  student_id      INT NOT NULL,
  subject_code    VARCHAR(10) NOT NULL,
  course_number   VARCHAR(10) NOT NULL,
  term_code       VARCHAR(10) NOT NULL,
  attendance_rate NUMERIC(5,2),
  absences        INT
);
