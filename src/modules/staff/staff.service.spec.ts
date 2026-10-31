import { BadRequestException, ForbiddenException, HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { StaffService } from './staff.service';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

describe('StaffService — sessions', () => {
  let svc: StaffService;
  let prisma: any;
  let jwt: JwtService;
  let email: any;
  const config: any = { get: (k: string) => ({ 'jwt.staffRefreshDays': 30, 'jwt.staffAccessExpiresIn': '15m' } as any)[k] };
  const user = { id: 'u1', email: 'a@b.com', fullName: 'Ama', role: 'DELIVERY_PARTNER', isActive: true, passwordHash: '', failedLoginAttempts: 0, lockedUntil: null as Date | null, resetCodeHash: null as string | null, resetExpiresAt: null as Date | null, resetAttempts: 0 };

  beforeAll(async () => { user.passwordHash = await bcrypt.hash('pw-123456', 4); });

  beforeEach(() => {
    prisma = {
      staffUser: { findUnique: jest.fn().mockResolvedValue(user), update: jest.fn().mockResolvedValue({ failedLoginAttempts: 1, resetAttempts: 1 }) },
      $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
      staffSession: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sess-new', ...data })),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    jwt = new JwtService({ secret: 'test-secret-test-secret-test-secret' });
    email = { sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined) };
    svc = new StaffService(prisma, jwt, config, email);
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

  describe('login lockout', () => {
    const bad = { email: 'a@b.com', password: 'wrong-pass' };

    it('counts a wrong password and answers 401', async () => {
      await expect(svc.login(bad)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.staffUser.update).toHaveBeenCalledWith(expect.objectContaining({ data: { failedLoginAttempts: { increment: 1 } } }));
    });

    it('locks on the 5th wrong password with 429 and Retry-After seconds', async () => {
      prisma.staffUser.update.mockResolvedValueOnce({ failedLoginAttempts: 5 });
      const err: any = await svc.login(bad).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(429);
      expect(err.getResponse()).toMatchObject({ code: 'ACCOUNT_LOCKED' });
      expect(err.getResponse().retryAfterSeconds).toBeGreaterThan(800);
      expect(prisma.staffUser.update).toHaveBeenCalledWith(expect.objectContaining({ data: { lockedUntil: expect.any(Date) } }));
    });

    it('refuses even the right password while locked, and does not count it', async () => {
      prisma.staffUser.findUnique.mockResolvedValue({ ...user, failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 60000) });
      const err: any = await svc.login({ email: 'a@b.com', password: 'pw-123456' }).catch((e) => e);
      expect(err.getStatus()).toBe(429);
      expect(prisma.staffUser.update).not.toHaveBeenCalled();
      expect(prisma.staffSession.create).not.toHaveBeenCalled();
    });

    it('starts fresh once the lock has run out', async () => {
      prisma.staffUser.findUnique.mockResolvedValue({ ...user, failedLoginAttempts: 5, lockedUntil: new Date(Date.now() - 1000) });
      await expect(svc.login({ email: 'a@b.com', password: 'pw-123456' })).resolves.toHaveProperty('accessToken');
      expect(prisma.staffUser.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    });

    it('clears earlier failures after a good login', async () => {
      prisma.staffUser.findUnique.mockResolvedValue({ ...user, failedLoginAttempts: 3 });
      await svc.login({ email: 'a@b.com', password: 'pw-123456' });
      expect(prisma.staffUser.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { failedLoginAttempts: 0 } });
    });

    it('still 401s (not 429) for an unknown email, and never writes', async () => {
      prisma.staffUser.findUnique.mockResolvedValue(null);
      await expect(svc.login(bad)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.staffUser.update).not.toHaveBeenCalled();
    });
  });

  describe('forgot / reset password', () => {
    const generic = { message: 'If an account exists for that email, a reset code has been sent.' };

    it('emails a code and stores only its hash', async () => {
      await expect(svc.forgotPassword({ email: 'a@b.com' })).resolves.toEqual(generic);
      const code = email.sendPasswordResetEmail.mock.calls[0][1];
      expect(code).toMatch(/^\d{6}$/);
      const data = prisma.staffUser.update.mock.calls[0][0].data;
      expect(await bcrypt.compare(code, data.resetCodeHash)).toBe(true);
      expect(data.resetAttempts).toBe(0);
    });

    it('answers identically for unknown and disabled accounts, sending nothing', async () => {
      prisma.staffUser.findUnique.mockResolvedValue(null);
      await expect(svc.forgotPassword({ email: 'x@y.com' })).resolves.toEqual(generic);
      prisma.staffUser.findUnique.mockResolvedValue({ ...user, isActive: false });
      await expect(svc.forgotPassword({ email: 'a@b.com' })).resolves.toEqual(generic);
      expect(email.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('sends at most one email a minute per account', async () => {
      prisma.staffUser.findUnique.mockResolvedValue({ ...user, resetExpiresAt: new Date(Date.now() + 14.5 * 60 * 1000) });
      await expect(svc.forgotPassword({ email: 'a@b.com' })).resolves.toEqual(generic);
      expect(email.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('does not reveal an email failure', async () => {
      email.sendPasswordResetEmail.mockRejectedValue(new Error('smtp down'));
      await expect(svc.forgotPassword({ email: 'a@b.com' })).resolves.toEqual(generic);
    });

    describe('reset', () => {
      let withCode: any;
      beforeAll(async () => { withCode = { ...user, resetCodeHash: await bcrypt.hash('123456', 4), resetExpiresAt: new Date(Date.now() + 1e6) }; });
      beforeEach(() => { prisma.staffUser.findUnique.mockResolvedValue(withCode); });
      const dto = (code = '123456') => ({ email: 'a@b.com', code, newPassword: 'brand-new-pw' });

      it('sets the new password, clears the code and lock, and ends every session', async () => {
        await svc.resetPassword(dto());
        const data = prisma.staffUser.update.mock.calls.at(-1)[0].data;
        expect(await bcrypt.compare('brand-new-pw', data.passwordHash)).toBe(true);
        expect(data).toMatchObject({ resetCodeHash: null, resetExpiresAt: null, failedLoginAttempts: 0, lockedUntil: null });
        expect(prisma.staffSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { staffUserId: 'u1', revokedAt: null } }));
      });

      it('rejects a wrong code with the generic error and counts the try', async () => {
        const err: any = await svc.resetPassword(dto('000000')).catch((e) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse().code).toBe('INVALID_RESET_CODE');
        expect(prisma.staffUser.update).toHaveBeenCalledWith(expect.objectContaining({ data: { resetAttempts: { increment: 1 } } }));
        expect(prisma.staffSession.updateMany).not.toHaveBeenCalled();
      });

      it('burns the code on the 5th wrong try', async () => {
        prisma.staffUser.update.mockResolvedValueOnce({ resetAttempts: 5 });
        await expect(svc.resetPassword(dto('000000'))).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.staffUser.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { resetCodeHash: null, resetExpiresAt: null, resetAttempts: 0 } });
      });

      it('does not compare once over the limit, even with the right code', async () => {
        prisma.staffUser.update.mockResolvedValueOnce({ resetAttempts: 6 });
        await expect(svc.resetPassword(dto())).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.staffSession.updateMany).not.toHaveBeenCalled();
      });

      it('rejects an expired code, an unknown email and a disabled account', async () => {
        prisma.staffUser.findUnique.mockResolvedValue({ ...withCode, resetExpiresAt: new Date(Date.now() - 1) });
        await expect(svc.resetPassword(dto())).rejects.toBeInstanceOf(BadRequestException);
        prisma.staffUser.findUnique.mockResolvedValue(null);
        await expect(svc.resetPassword(dto())).rejects.toBeInstanceOf(BadRequestException);
        prisma.staffUser.findUnique.mockResolvedValue({ ...withCode, isActive: false });
        await expect(svc.resetPassword(dto())).rejects.toBeInstanceOf(BadRequestException);
      });
    });
  });

  describe('change password', () => {
    it('changes it and signs out the OTHER devices only', async () => {
      await svc.changePassword('u1', 'sess-now', { currentPassword: 'pw-123456', newPassword: 'another-pw-1' });
      const data = prisma.staffUser.update.mock.calls.at(-1)[0].data;
      expect(await bcrypt.compare('another-pw-1', data.passwordHash)).toBe(true);
      expect(prisma.staffSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { staffUserId: 'u1', revokedAt: null, id: { not: 'sess-now' } },
      }));
    });

    it('a wrong current password is a 400 (never 401) and counts toward the lockout', async () => {
      const err: any = await svc.changePassword('u1', 's', { currentPassword: 'nope-nope', newPassword: 'another-pw-1' }).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse().code).toBe('INVALID_CURRENT_PASSWORD');
      expect(prisma.staffUser.update).toHaveBeenCalledWith(expect.objectContaining({ data: { failedLoginAttempts: { increment: 1 } } }));
    });

    it('refuses the same password', async () => {
      const err: any = await svc.changePassword('u1', 's', { currentPassword: 'pw-123456', newPassword: 'pw-123456' }).catch((e) => e);
      expect(err.getResponse().code).toBe('SAME_PASSWORD');
    });
  });

  describe('profile never leaks secrets', () => {
    it('strips password, reset and lockout fields', async () => {
      prisma.staffUser.findUnique.mockResolvedValue({ ...user, resetCodeHash: 'x', lockedUntil: new Date() });
      const me: any = await svc.getProfile('u1');
      for (const k of ['passwordHash', 'resetCodeHash', 'resetExpiresAt', 'resetAttempts', 'failedLoginAttempts', 'lockedUntil']) {
        expect(me).not.toHaveProperty(k);
      }
      expect(me.email).toBe('a@b.com');
    });
  });
});
