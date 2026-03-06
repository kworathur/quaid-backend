/**
 * POST   /testing/degreeworks/rows  — insert rows into DegreeWorks tables
 * PUT    /testing/degreeworks/rows  — update rows in DegreeWorks tables
 * DELETE /testing/degreeworks/rows  — delete rows in DegreeWorks tables
 * Scope: com.apigw/scope1
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  ExecuteStatementCommand,
  RDSDataClient,
  SqlParameter,
} from '@aws-sdk/client-rds-data';
import * as z from 'zod';
import {
  errorResponse,
  validationErrorResponse,
} from '../../lib/serverResponseBuilder';

const rdsData = new RDSDataClient({});

const CLUSTER_ARN = process.env.DEGREE_WORKS_CLUSTER_ARN!;
const SECRET_ARN = process.env.DEGREE_WORKS_SECRET_ARN!;
const DB_NAME = process.env.DEGREE_WORKS_DB_NAME!;

const TABLE_NAMES = [
  'programs',
  'courses',
  'course_attributes',
  'degree_requirements',
  'student_programs',
  'student_courses',
  'student_gpa',
  'scholarships',
  'scholarship_rules',
  'student_scholarships',
  'student_attendance',
] as const;

type TableName = (typeof TABLE_NAMES)[number];
type SqlPrimitive = string | number | boolean | null;
type SqlRecord = Record<string, SqlPrimitive>;

const TABLE_COLUMNS: Record<TableName, readonly string[]> = {
  programs: [
    'program_id',
    'program_code',
    'program_name',
    'degree_type',
    'total_credits_required',
    'department',
    'is_active',
  ],
  courses: [
    'course_id',
    'subject_code',
    'course_number',
    'course_name',
    'credit_hours',
    'description',
    'is_active',
  ],
  course_attributes: ['attribute_id', 'course_id', 'attribute_code', 'attribute_name'],
  degree_requirements: [
    'req_id',
    'program_id',
    'req_type',
    'req_name',
    'subject_code',
    'course_number',
    'attribute_code',
    'min_credits',
    'min_grade',
  ],
  student_programs: [
    'sp_id',
    'student_id',
    'program_id',
    'declared_date',
    'is_active',
    'expected_graduation',
  ],
  student_courses: [
    'sc_id',
    'student_id',
    'subject_code',
    'course_number',
    'course_id',
    'term_code',
    'grade',
    'credits_earned',
    'status',
  ],
  student_gpa: [
    'gpa_id',
    'student_id',
    'term_code',
    'gpa',
    'total_credits_attempted',
    'total_credits_earned',
  ],
  scholarships: [
    'scholarship_id',
    'scholarship_code',
    'scholarship_name',
    'description',
    'is_active',
  ],
  scholarship_rules: [
    'rule_id',
    'scholarship_id',
    'rule_type',
    'rule_operator',
    'rule_value',
    'disqualifies',
  ],
  student_scholarships: [
    'ss_id',
    'student_id',
    'scholarship_id',
    'status',
    'term_code',
    'reason',
  ],
  student_attendance: [
    'att_id',
    'student_id',
    'subject_code',
    'course_number',
    'term_code',
    'attendance_rate',
    'absences',
  ],
};

const sqlValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

const nonEmptyRecordSchema = z
  .record(z.string(), sqlValueSchema)
  .refine((row) => Object.keys(row).length > 0, {
    message: 'At least one column/value pair is required',
  });

const insertRequestSchema = z.object({
  table: z.enum(TABLE_NAMES),
  rows: z.array(nonEmptyRecordSchema).min(1).max(500),
});

const updateRequestSchema = z.object({
  table: z.enum(TABLE_NAMES),
  updates: z
    .array(
      z.object({
        match: nonEmptyRecordSchema,
        set: nonEmptyRecordSchema,
      }),
    )
    .min(1)
    .max(500),
});

const deleteRequestSchema = z.object({
  table: z.enum(TABLE_NAMES),
  where: z.array(nonEmptyRecordSchema).min(1).max(500),
});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.info('received:', event);

  switch (event.httpMethod) {
    case 'POST':
      return insertRows(event.body);
    case 'PUT':
      return updateRows(event.body);
    case 'DELETE':
      return deleteRows(event.body);
    default:
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
};

function parseBody<T>(
  rawBody: string | null,
  schema: z.ZodSchema<T>,
):
  | { ok: true; data: T }
  | { ok: false; response: APIGatewayProxyResult } {
  if (!rawBody) {
    return {
      ok: false,
      response: errorResponse(400, 'BAD_REQUEST', 'Request body required'),
    };
  }

  try {
    return { ok: true, data: schema.parse(JSON.parse(rawBody)) };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, response: validationErrorResponse(err) };
    }
    return {
      ok: false,
      response: errorResponse(400, 'BAD_REQUEST', 'Invalid JSON'),
    };
  }
}

function quoteIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

function validateColumns(table: TableName, rows: SqlRecord[]): string[] {
  const allowed = new Set(TABLE_COLUMNS[table]);
  const invalid = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) {
        invalid.add(key);
      }
    }
  }

  return Array.from(invalid);
}

function toSqlParameter(name: string, value: SqlPrimitive): SqlParameter {
  if (value === null) {
    return { name, value: { isNull: true } };
  }
  if (typeof value === 'boolean') {
    return { name, value: { booleanValue: value } };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid numeric value for ${name}`);
    }
    if (Number.isSafeInteger(value)) {
      return { name, value: { longValue: value } };
    }
    return { name, value: { doubleValue: value } };
  }
  return { name, value: { stringValue: value } };
}

async function insertRows(rawBody: string | null): Promise<APIGatewayProxyResult> {
  const parsed = parseBody(rawBody, insertRequestSchema);
  if (!parsed.ok) {
    return parsed.response;
  }

  const { table, rows } = parsed.data;
  const invalidColumns = validateColumns(table, rows);
  if (invalidColumns.length > 0) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      `Invalid columns for table ${table}`,
      { invalidColumns },
    );
  }

  try {
    for (const row of rows) {
      const columns = Object.keys(row);
      const quotedColumns = columns.map((column) => quoteIdentifier(column));
      const parameters = columns.map((column, index) =>
        toSqlParameter(`v${index}`, row[column]!),
      );
      const placeholders = columns.map((_, index) => `:v${index}`);

      const sql = `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns.join(', ')}) VALUES (${placeholders.join(', ')})`;

      await rdsData.send(
        new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DB_NAME,
          sql,
          parameters,
        }),
      );
    }
  } catch (err) {
    console.error('Error inserting DegreeWorks rows:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'DegreeWorks rows inserted',
      table,
      inserted: rows.length,
    }),
  };
}

async function updateRows(rawBody: string | null): Promise<APIGatewayProxyResult> {
  const parsed = parseBody(rawBody, updateRequestSchema);
  if (!parsed.ok) {
    return parsed.response;
  }

  const { table, updates } = parsed.data;
  const invalidColumns = validateColumns(
    table,
    updates.flatMap((update) => [update.match, update.set]),
  );
  if (invalidColumns.length > 0) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      `Invalid columns for table ${table}`,
      { invalidColumns },
    );
  }

  try {
    for (const update of updates) {
      const setColumns = Object.keys(update.set);
      const matchColumns = Object.keys(update.match);

      const setClause = setColumns
        .map((column, index) => `${quoteIdentifier(column)} = :s${index}`)
        .join(', ');
      const whereClause = matchColumns
        .map((column, index) => `${quoteIdentifier(column)} = :w${index}`)
        .join(' AND ');

      const sql = `UPDATE ${quoteIdentifier(table)} SET ${setClause} WHERE ${whereClause}`;

      const setParams = setColumns.map((column, index) =>
        toSqlParameter(`s${index}`, update.set[column]!),
      );
      const whereParams = matchColumns.map((column, index) =>
        toSqlParameter(`w${index}`, update.match[column]!),
      );

      await rdsData.send(
        new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DB_NAME,
          sql,
          parameters: [...setParams, ...whereParams],
        }),
      );
    }
  } catch (err) {
    console.error('Error updating DegreeWorks rows:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'DegreeWorks rows updated',
      table,
      updated: updates.length,
    }),
  };
}

async function deleteRows(rawBody: string | null): Promise<APIGatewayProxyResult> {
  const parsed = parseBody(rawBody, deleteRequestSchema);
  if (!parsed.ok) {
    return parsed.response;
  }

  const { table, where } = parsed.data;
  const invalidColumns = validateColumns(table, where);
  if (invalidColumns.length > 0) {
    return errorResponse(
      400,
      'BAD_REQUEST',
      `Invalid columns for table ${table}`,
      { invalidColumns },
    );
  }

  try {
    for (const clause of where) {
      const columns = Object.keys(clause);
      const whereSql = columns
        .map((column, index) => `${quoteIdentifier(column)} = :w${index}`)
        .join(' AND ');

      const sql = `DELETE FROM ${quoteIdentifier(table)} WHERE ${whereSql}`;
      const parameters = columns.map((column, index) =>
        toSqlParameter(`w${index}`, clause[column]!),
      );

      await rdsData.send(
        new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DB_NAME,
          sql,
          parameters,
        }),
      );
    }
  } catch (err) {
    console.error('Error deleting DegreeWorks rows:', err);
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'DegreeWorks rows deleted',
      table,
      deleted: where.length,
    }),
  };
}
