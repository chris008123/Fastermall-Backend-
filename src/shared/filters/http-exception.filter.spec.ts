import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function run(exception: unknown) {
  const json = jest.fn();
  const setHeader = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => ({ status, setHeader }),
      getRequest: () => ({ method: 'POST', url: '/api/v1/x', requestId: 'req-12345678' }),
    }),
  };
  new HttpExceptionFilter().catch(exception, host);
  return { status: status.mock.calls[0][0], body: json.mock.calls[0][0], setHeader };
}

describe('HttpExceptionFilter', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));

  it('keeps a code a service set, and the message', () => {
    const { status, body } = run(new ConflictException({ message: 'Taken', code: 'JOB_ALREADY_TAKEN' }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ success: false, message: 'Taken', code: 'JOB_ALREADY_TAKEN', requestId: 'req-12345678', statusCode: 409 });
  });

  it('derives a code from the status when none is set', () => {
    expect(run(new ForbiddenException('No')).body).toMatchObject({ code: 'FORBIDDEN', message: 'No' });
    expect(run(new NotFoundException('Gone')).body.code).toBe('NOT_FOUND');
    expect(run(new HttpException('slow down', 429)).body.code).toBe('TOO_MANY_REQUESTS');
  });

  it('turns validation messages into field errors', () => {
    const { body } = run(new BadRequestException(['number must be 10 digits', 'email must be an email']));
    expect(body).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Some of the details are not valid' });
    expect(body.errors).toEqual([
      { field: 'number', message: 'number must be 10 digits' },
      { field: 'email', message: 'email must be an email' },
    ]);
  });

  it('sets Retry-After when the error carries retryAfterSeconds', () => {
    const { status, setHeader, body } = run(new HttpException({ message: 'Locked', code: 'ACCOUNT_LOCKED', retryAfterSeconds: 900 }, 429));
    expect(status).toBe(429);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '900');
    expect(body.code).toBe('ACCOUNT_LOCKED');
  });

  it('hides internals on unexpected errors', () => {
    const { status, body } = run(new Error('db password is hunter2'));
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Something went wrong on our side' });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});
