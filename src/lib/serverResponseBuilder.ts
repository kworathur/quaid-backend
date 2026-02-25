import type { APIGatewayProxyResult } from 'aws-lambda';
import type { ZodError } from 'zod';
import * as z from 'zod';
import { type ErrorCode, RESPONSES, ResponseType } from './types/apiResponse';

export class ServerResponseBuilder {
  private statusCode: number;
  private message: string;
  private errorCode?: ErrorCode;
  private details?: unknown;

  constructor(responseType: ResponseType) {
    const responseDetails = RESPONSES[responseType];
    this.message = responseDetails.message;
    this.statusCode = responseDetails.code;
  }

  setMessage(message: string): ServerResponseBuilder {
    this.message = message;
    return this;
  }

  setErrorCode(code: ErrorCode): ServerResponseBuilder {
    this.errorCode = code;
    return this;
  }

  setDetails(details: unknown): ServerResponseBuilder {
    this.details = details;
    return this;
  }

  build(): APIGatewayProxyResult {
    if (this.errorCode) {
      return {
        statusCode: this.statusCode,
        body: JSON.stringify({
          status: 'error',
          statusCode: this.statusCode,
          error: {
            code: this.errorCode,
            message: this.message,
            ...(this.details !== undefined ? { details: this.details } : {}),
          },
        }),
      };
    }

    return {
      statusCode: this.statusCode,
      body: JSON.stringify({ message: this.message }),
    };
  }
}

export function errorResponse(
  statusCode: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify({
      status: 'error',
      statusCode,
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    }),
  };
}

export function validationErrorResponse(err: ZodError): APIGatewayProxyResult {
  return errorResponse(400, 'BAD_REQUEST', 'Validation failed', z.treeifyError(err));
}
