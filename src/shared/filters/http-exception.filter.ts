import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

// Stable error codes the apps can branch on. A service can set its own with
// `new ConflictException({ message, code: 'JOB_ALREADY_TAKEN' })`; anything
// that does not falls back to a code derived from the HTTP status.
const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE',
  429: 'TOO_MANY_REQUESTS',
};

// class-validator messages start with the property name ("number must be...").
function toFieldErrors(messages: string[]) {
  return messages.map((m) => {
    const field = /^([A-Za-z_][\w.\[\]]*) /.exec(m)?.[1];
    return field ? { field, message: m } : { message: m };
  });
}

// Standardizes every error response coming out of the backend, regardless
// of which module (validation, auth, business rule, payment, DB...) threw it.
//
// Shape (the older `statusCode`, `path`, `timestamp` and `error` keys stay so
// the customer app keeps working):
// { success:false, message, code, errors?, requestId, statusCode, path, timestamp, error }
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId: string | undefined = (request as any).requestId;

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const raw =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Unexpected error';

    let message = 'Unexpected error';
    let code: string | undefined;
    let errors: { field?: string; message: string }[] | undefined;

    if (typeof raw === 'string') {
      message = raw;
    } else if (raw && typeof raw === 'object') {
      const body = raw as { message?: unknown; code?: unknown };
      if (Array.isArray(body.message)) {
        errors = toFieldErrors(body.message.map(String));
        message = 'Some of the details are not valid';
        code = 'VALIDATION_FAILED';
      } else if (typeof body.message === 'string') {
        message = body.message;
      }
      if (typeof body.code === 'string') code = body.code;
    }

    // Never leak internals for unexpected errors.
    if (status >= 500) message = 'Something went wrong on our side';

    code ??= status >= 500 ? 'INTERNAL_ERROR' : (CODE_BY_STATUS[status] ?? 'ERROR');

    this.logger.error(
      `[${requestId ?? '-'}] ${request.method} ${request.url} -> ${status} ${code}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(status).json({
      success: false,
      message,
      code,
      ...(errors ? { errors } : {}),
      requestId,
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      error: raw,
    });
  }
}
