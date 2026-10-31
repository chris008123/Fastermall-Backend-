import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Observable, from, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { PrismaService } from '../../database/prisma.service';

const KEY_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
// A request that never finished (the server restarted mid-way) is treated as
// abandoned after this long, so the key is not stuck forever.
const ABANDONED_AFTER_MS = 60 * 1000;

/**
 * Makes an action safe to repeat. Attach with
 * `@UseInterceptors(IdempotencyInterceptor)` to a route that changes state.
 *
 * - No `Idempotency-Key` header: the route behaves exactly as before.
 * - Same key and same request again: the first result is returned and the
 *   action does NOT run a second time (`Idempotent-Replayed: true`).
 * - Same key but a different request: 422 `IDEMPOTENCY_KEY_REUSED`.
 * - Same key while the first is still running: 409 `IDEMPOTENCY_IN_PROGRESS`.
 * - If the first attempt failed, nothing is remembered and a retry runs again.
 *
 * Keys are per signed-in user and kept for 24 hours.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const key: string | undefined = req.header?.('Idempotency-Key') ?? req.headers?.['idempotency-key'];
    if (!key) return next.handle();

    if (!KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        message: 'Idempotency-Key must be 8 to 128 letters, numbers, dots, dashes or underscores',
        code: 'INVALID_IDEMPOTENCY_KEY',
      });
    }

    const userId: string | undefined = req.user?.userId;
    if (!userId) return next.handle();

    const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    const fingerprint = createHash('sha256')
      .update(`${req.method} ${path} ${JSON.stringify(req.body ?? {})}`)
      .digest('hex');

    const claimed = await this.claim(userId, key, fingerprint);

    if (claimed.replay) {
      res.setHeader?.('Idempotent-Replayed', 'true');
      return of(claimed.response);
    }

    return next.handle().pipe(
      mergeMap((data) =>
        from(this.save(claimed.id, data)).pipe(mergeMap(() => of(data))),
      ),
      catchError((err) =>
        from(this.release(claimed.id)).pipe(mergeMap(() => throwError(() => err))),
      ),
    );
  }

  private async claim(
    userId: string,
    key: string,
    fingerprint: string,
    retried = false,
  ): Promise<{ replay: false; id: string } | { replay: true; response: unknown }> {
    // A key older than 24 hours counts as unused.
    await this.prisma.idempotencyKey.deleteMany({
      where: {
        staffUserId: userId,
        key,
        createdAt: { lt: new Date(Date.now() - KEY_LIFETIME_MS) },
      },
    });

    try {
      const row = await this.prisma.idempotencyKey.create({
        data: { staffUserId: userId, key, fingerprint },
        select: { id: true },
      });
      return { replay: false, id: row.id };
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
    }

    // The key already exists.
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { staffUserId_key: { staffUserId: userId, key } },
    });

    if (!existing) {
      // Deleted between our two queries. Try once more.
      if (retried) throw new ConflictException({ message: 'Please try again', code: 'IDEMPOTENCY_IN_PROGRESS' });
      return this.claim(userId, key, fingerprint, true);
    }

    if (existing.fingerprint !== fingerprint) {
      throw new HttpException(
        {
          message: 'This Idempotency-Key was already used for a different request',
          code: 'IDEMPOTENCY_KEY_REUSED',
        },
        422,
      );
    }

    if (existing.completedAt) {
      return { replay: true, response: existing.response };
    }

    if (existing.createdAt.getTime() < Date.now() - ABANDONED_AFTER_MS && !retried) {
      await this.prisma.idempotencyKey.deleteMany({
        where: { id: existing.id, completedAt: null },
      });
      return this.claim(userId, key, fingerprint, true);
    }

    throw new ConflictException({
      message: 'The first request with this key is still being processed',
      code: 'IDEMPOTENCY_IN_PROGRESS',
      retryAfterSeconds: 1,
    });
  }

  private async save(id: string, data: unknown) {
    // JSON round-trip: what is stored is what a client would have received
    // (dates as strings, no undefined).
    const response = JSON.parse(JSON.stringify(data ?? null));
    await this.prisma.idempotencyKey.update({
      where: { id },
      data: { response, completedAt: new Date() },
    });
  }

  private async release(id: string) {
    await this.prisma.idempotencyKey.deleteMany({ where: { id, completedAt: null } });
  }
}
