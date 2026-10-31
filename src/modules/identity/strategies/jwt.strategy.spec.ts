import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  let prisma: any;
  let strategy: JwtStrategy;
  const config: any = { get: () => 'test-secret-test-secret-test-secret' };
  const live = { staffUserId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() + 1e7), staffUser: { isActive: true, role: 'DELIVERY_PARTNER', email: 'a@b.com' } };

  beforeEach(() => {
    prisma = { staffSession: { findUnique: jest.fn().mockResolvedValue(live) } };
    strategy = new JwtStrategy(config, prisma);
  });

  it('lets customer tokens (no role) through without a database lookup', async () => {
    await expect(strategy.validate({ sub: 'c1', email: 'c@x.com' })).resolves.toMatchObject({ userId: 'c1' });
    expect(prisma.staffSession.findUnique).not.toHaveBeenCalled();
  });

  it("lets customer tokens with role 'CUSTOMER' through (this is what customer login issues)", async () => {
    await expect(strategy.validate({ sub: 'c1', email: 'c@x.com', role: 'CUSTOMER' })).resolves.toMatchObject({ userId: 'c1', role: 'CUSTOMER' });
    expect(prisma.staffSession.findUnique).not.toHaveBeenCalled();
  });

  it('accepts a staff token with a live session, taking the role from the database', async () => {
    await expect(strategy.validate({ sub: 'u1', email: 'old@x.com', role: 'ADMIN', sid: 's1' })).resolves.toEqual({
      userId: 'u1', email: 'a@b.com', role: 'DELIVERY_PARTNER', sessionId: 's1',
    });
  });

  it.each([
    ['no session id (old token)', { sub: 'u1', email: 'e', role: 'DELIVERY_PARTNER' }, live],
    ['session not found', { sub: 'u1', email: 'e', role: 'DELIVERY_PARTNER', sid: 's1' }, null],
    ['logged out', { sub: 'u1', email: 'e', role: 'DELIVERY_PARTNER', sid: 's1' }, { ...live, revokedAt: new Date() }],
    ['session expired', { sub: 'u1', email: 'e', role: 'DELIVERY_PARTNER', sid: 's1' }, { ...live, expiresAt: new Date(Date.now() - 1) }],
    ['account disabled', { sub: 'u1', email: 'e', role: 'DELIVERY_PARTNER', sid: 's1' }, { ...live, staffUser: { ...live.staffUser, isActive: false } }],
    ['session belongs to someone else', { sub: 'u2', email: 'e', role: 'DELIVERY_PARTNER', sid: 's1' }, live],
  ])('401s: %s', async (_n, payload, session) => {
    prisma.staffSession.findUnique.mockResolvedValue(session);
    await expect(strategy.validate(payload as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
