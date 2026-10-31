import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { StaffService } from './staff.service';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

describe('StaffService — sessions', () => {
  let svc: StaffService;
  let prisma: any;
  let jwt: JwtService;
  const config: any = { get: (k: string) => ({ 'jwt.staffRefreshDays': 30, 'jwt.staffAccessExpiresIn': '15m' } as any)[k] };
  const user = { id: 'u1', email: 'a@b.com', fullName: 'Ama', role: 'DELIVERY_PARTNER', isActive: true, passwordHash: '' };

  beforeAll(async () => { user.passwordHash = await bcrypt.hash('pw-123456', 4); });

  beforeEach(() => {
    prisma = {
      staffUser: { findUnique: jest.fn().mockResolvedValue(user), update: jest.fn() },
      staffSession: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sess-new', ...data })),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    jwt = new JwtService({ secret: 'test-secret-test-secret-test-secret' });
    svc = new StaffService(prisma, jwt, config);
  });

  describe('login', () => {
    it('creates a session and returns access + refresh tokens', async () => {
      const res: any = await svc.login({ email: 'a@b.com', password: 'pw-123456' });
      const payload: any = jwt.decode(res.accessToken);
      expect(payload).toMatchObject({ sub: 'u1', role: 'DELIVERY_PARTNER', sid: 'sess-new' });
      expect(res.expiresIn).toBe(900);
      expect(res.refreshToken.length).toBeGreaterThan(40);
      // only the hash of the refresh token is stored
      const stored = prisma.staffSession.create.mock.calls[0][0].data;
      expect(stored.refreshTokenHash).toBe(sha(res.refreshToken));
      expect(JSON.stringify(stored)).not.toContain(res.refreshToken);
    });

    it('gives the same error for unknown email and wrong password', async () => {
      prisma.staffUser.findUnique.mockResolvedValue(null);
      const a = await svc.login({ email: 'x@y.com', password: 'whatever1' }).catch((e) => e);
      prisma.staffUser.findUnique.mockResolvedValue(user);
      const b = await svc.login({ email: 'a@b.com', password: 'wrong-pass' }).catch((e) => e);
      expect(a).toBeInstanceOf(UnauthorizedException);
      expect(b).toBeInstanceOf(UnauthorizedException);
      expect(a.message).toBe(b.message);
    });

    it('refuses a disabled account (403 ACCOUNT_DISABLED) without creating a session', async () => {
      prisma.staffUser.findUnique.mockResolvedValue({ ...user, isActive: false });
      const err: any = await svc.login({ email: 'a@b.com', password: 'pw-123456' }).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse().code).toBe('ACCOUNT_DISABLED');
      expect(prisma.staffSession.create).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    const live = { id: 's1', staffUserId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() + 1e7), staffUser: user };

    it('rotates: retires the old session and issues new tokens', async () => {
      prisma.staffSession.findUnique.mockResolvedValue(live);
      const res: any = await svc.refresh('old-refresh-token');
      expect(prisma.staffSession.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { refreshTokenHash: sha('old-refresh-token') } }));
      expect(prisma.staffSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's1', revokedAt: null } }));
      expect(res.refreshToken).not.toBe('old-refresh-token');
      expect(res.accessToken).toBeDefined();
    });

    it('rejects an unknown token', async () => {
      prisma.staffSession.findUnique.mockResolvedValue(null);
      await expect(svc.refresh('nope')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('ends ALL sessions when a used token is shown again', async () => {
      prisma.staffSession.findUnique.mockResolvedValue({ ...live, revokedAt: new Date() });
      const err: any = await svc.refresh('stolen').catch((e) => e);
      expect(err.getResponse().code).toBe('SESSION_REUSED');
      expect(prisma.staffSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { staffUserId: 'u1', revokedAt: null } }));
      expect(prisma.staffSession.create).not.toHaveBeenCalled();
    });

    it('rejects an expired session and a disabled account', async () => {
      prisma.staffSession.findUnique.mockResolvedValue({ ...live, expiresAt: new Date(Date.now() - 1) });
      await expect(svc.refresh('t')).rejects.toBeInstanceOf(UnauthorizedException);
      prisma.staffSession.findUnique.mockResolvedValue({ ...live, staffUser: { ...user, isActive: false } });
      await expect(svc.refresh('t')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when a parallel refresh already used the token', async () => {
      prisma.staffSession.findUnique.mockResolvedValue(live);
      prisma.staffSession.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.refresh('t')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.staffSession.create).not.toHaveBeenCalled();
    });
  });

  describe('logout and disable', () => {
    it('revokes only the current session', async () => {
      await expect(svc.logout('s1')).resolves.toEqual({ loggedOut: true });
      expect(prisma.staffSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's1', revokedAt: null } }));
    });

    it('disabling an account ends all of its sessions', async () => {
      await svc.setActive('u1', false, 'admin1');
      expect(prisma.staffUser.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { isActive: false } });
      expect(prisma.staffSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { staffUserId: 'u1', revokedAt: null } }));
    });

    it('re-enabling does not touch sessions', async () => {
      await svc.setActive('u1', true, 'admin1');
      expect(prisma.staffSession.updateMany).not.toHaveBeenCalled();
    });

    it('stops an admin disabling themselves, and 404s on unknown accounts', async () => {
      await expect(svc.setActive('admin1', false, 'admin1')).rejects.toBeInstanceOf(BadRequestException);
      prisma.staffUser.findUnique.mockResolvedValue(null);
      await expect(svc.setActive('ghost', false, 'admin1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
