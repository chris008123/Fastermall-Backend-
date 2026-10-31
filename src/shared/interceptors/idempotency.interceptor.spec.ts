import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { createHash } from 'crypto';
import { lastValueFrom, of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';

const KEY = 'abc12345-key';

function ctx(over: any = {}) {
  const res = { setHeader: jest.fn() };
  const req = {
    method: 'POST',
    originalUrl: '/api/v1/logistics/deliveries/d1/accept?x=1',
    body: {},
    user: { userId: 'u1' },
    header: (n: string) => (n === 'Idempotency-Key' ? KEY : undefined),
    ...over,
  };
  return { res, ctx: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as any, req };
}

describe('IdempotencyInterceptor', () => {
  let prisma: any;
  let it_: IdempotencyInterceptor;
  const fp = (req: any) =>
    createHash('sha256').update(`${req.method} ${String(req.originalUrl).split('?')[0]} ${JSON.stringify(req.body ?? {})}`).digest('hex');

  beforeEach(() => {
    prisma = {
      idempotencyKey: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'k1' }),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    it_ = new IdempotencyInterceptor(prisma);
  });

  const run = async (c: any, handler: any) => lastValueFrom(await it_.intercept(c, { handle: handler }));

  it('does nothing without the header', async () => {
    const { ctx: c } = ctx({ header: () => undefined });
    const handler = jest.fn().mockReturnValue(of('done'));
    await expect(run(c, handler)).resolves.toBe('done');
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed key', async () => {
    const { ctx: c } = ctx({ header: () => 'short' });
    await expect(it_.intercept(c, { handle: jest.fn() })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('runs the action once and stores the result', async () => {
    const { ctx: c } = ctx();
    const handler = jest.fn().mockReturnValue(of({ id: 'd1', at: new Date('2026-10-24T14:14:00Z') }));
    await expect(run(c, handler)).resolves.toMatchObject({ id: 'd1' });
    const saved = prisma.idempotencyKey.update.mock.calls[0][0];
    expect(saved.where).toEqual({ id: 'k1' });
    expect(saved.data.response).toEqual({ id: 'd1', at: '2026-10-24T14:14:00.000Z' });
    expect(saved.data.completedAt).toBeInstanceOf(Date);
  });

  it('replays the first result without running the action again', async () => {
    const { ctx: c, res, req } = ctx();
    prisma.idempotencyKey.create.mockRejectedValue({ code: 'P2002' });
    prisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'k1', fingerprint: fp(req), completedAt: new Date(), response: { id: 'd1' }, createdAt: new Date() });
    const handler = jest.fn();
    await expect(run(c, handler)).resolves.toEqual({ id: 'd1' });
    expect(handler).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
  });

  it('refuses the same key for a different request (422)', async () => {
    const { ctx: c } = ctx();
    prisma.idempotencyKey.create.mockRejectedValue({ code: 'P2002' });
    prisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'k1', fingerprint: 'something-else', completedAt: new Date(), response: {}, createdAt: new Date() });
    const err: any = await it_.intercept(c, { handle: jest.fn() }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse().code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('treats a different body as a different request', async () => {
    const a = ctx({ body: { status: 'PICKED_UP' } });
    prisma.idempotencyKey.create.mockRejectedValue({ code: 'P2002' });
    prisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'k1', fingerprint: fp({ ...a.req, body: { status: 'DELIVERED' } }), completedAt: new Date(), response: {}, createdAt: new Date() });
    await expect(it_.intercept(a.ctx, { handle: jest.fn() })).rejects.toBeInstanceOf(HttpException);
  });

  it('answers 409 while the first request is still running', async () => {
    const { ctx: c, req } = ctx();
    prisma.idempotencyKey.create.mockRejectedValue({ code: 'P2002' });
    prisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'k1', fingerprint: fp(req), completedAt: null, createdAt: new Date() });
    const err: any = await it_.intercept(c, { handle: jest.fn() }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });

  it('takes over a request that never finished (older than a minute)', async () => {
    const { ctx: c, req } = ctx();
    prisma.idempotencyKey.create.mockRejectedValueOnce({ code: 'P2002' }).mockResolvedValueOnce({ id: 'k2' });
    prisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'k1', fingerprint: fp(req), completedAt: null, createdAt: new Date(Date.now() - 120000) });
    await expect(run(c, jest.fn().mockReturnValue(of('ok')))).resolves.toBe('ok');
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledWith({ where: { id: 'k1', completedAt: null } });
  });

  it('forgets the key when the action fails, so a retry runs again', async () => {
    const { ctx: c } = ctx();
    await expect(run(c, jest.fn().mockReturnValue(throwError(() => new ConflictException('taken'))))).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenLastCalledWith({ where: { id: 'k1', completedAt: null } });
    expect(prisma.idempotencyKey.update).not.toHaveBeenCalled();
  });

  it('passes through unexpected database errors', async () => {
    const { ctx: c } = ctx();
    prisma.idempotencyKey.create.mockRejectedValue(new Error('db down'));
    await expect(it_.intercept(c, { handle: jest.fn() })).rejects.toThrow('db down');
  });
});
