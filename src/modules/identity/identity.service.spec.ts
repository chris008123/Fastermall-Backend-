import { BadRequestException, ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { IdentityService } from './identity.service';

function setup() {
  const prisma = { user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() } };
  const jwt = { sign: jest.fn().mockReturnValue('token') };
  const email = { sendOtpEmail: jest.fn(), sendPasswordResetEmail: jest.fn() };
  const svc = new IdentityService(prisma as any, jwt as any, email as any);
  return { prisma, email, svc };
}

const reg = { email: 'a@b.c', password: 'password1', fullName: 'A B' };

describe('IdentityService.register', () => {
  it('rejects an email that already belongs to a verified account', async () => {
    const { svc, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue({ id: 'u', isVerified: true });
    await expect(svc.register(reg)).rejects.toBeInstanceOf(ConflictException);
  });

  it('lets the real owner restart an unverified sign-up instead of being locked out', async () => {
    const { svc, prisma, email } = setup();
    prisma.user.findUnique.mockResolvedValue({ id: 'u', isVerified: false });

    await svc.register(reg);

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u' }, data: expect.objectContaining({ otpAttempts: 0 }) }),
    );
    expect(email.sendOtpEmail).toHaveBeenCalledTimes(1);
  });

  it('creates a new unverified user otherwise', async () => {
    const { svc, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue(null);
    await svc.register(reg);
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });
});

describe('IdentityService.verifyOtp attempt limit', () => {
  const future = new Date(Date.now() + 60_000);

  it('counts wrong codes and burns the code on the 5th', async () => {
    const { svc, prisma } = setup();
    const otpCodeHash = await bcrypt.hash('123456', 4);

    prisma.user.findUnique.mockResolvedValue({ id: 'u', isVerified: false, otpCodeHash, otpExpiresAt: future, otpAttempts: 2 });
    await expect(svc.verifyOtp({ email: 'a@b.c', code: '000000' })).rejects.toThrow('Incorrect code');
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ otpAttempts: 3, codeFailures: { increment: 1 } });

    prisma.user.findUnique.mockResolvedValue({ id: 'u', isVerified: false, otpCodeHash, otpExpiresAt: future, otpAttempts: 4 });
    await expect(svc.verifyOtp({ email: 'a@b.c', code: '000000' })).rejects.toThrow(/Too many incorrect attempts/);
    expect(prisma.user.update.mock.calls[1][0].data).toEqual({ otpAttempts: 0, otpCodeHash: null, otpExpiresAt: null, codeFailures: { increment: 1 } });
  });

  it('verifies on the right code', async () => {
    const { svc, prisma } = setup();
    const otpCodeHash = await bcrypt.hash('123456', 4);
    prisma.user.findUnique.mockResolvedValue({ id: 'u', isVerified: false, otpCodeHash, otpExpiresAt: future, otpAttempts: 1 });
    prisma.user.update.mockResolvedValue({ id: 'u', email: 'a@b.c', fullName: 'A' });

    const out = await svc.verifyOtp({ email: 'a@b.c', code: '123456' });
    expect(out.accessToken).toBe('token');
  });
});

describe('IdentityService password reset', () => {
  it('answers the same for unknown emails and sends nothing', async () => {
    const { svc, prisma, email } = setup();
    prisma.user.findUnique.mockResolvedValue(null);
    const out = await svc.forgotPassword({ email: 'ghost@b.c' });
    expect(out.message).toMatch(/If an account exists/);
    expect(email.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('emails a code to a verified account', async () => {
    const { svc, prisma, email } = setup();
    prisma.user.findUnique.mockResolvedValue({ id: 'u', isVerified: true });
    const out = await svc.forgotPassword({ email: 'a@b.c' });
    expect(out.message).toMatch(/If an account exists/);
    expect(email.sendPasswordResetEmail).toHaveBeenCalledWith('a@b.c', expect.stringMatching(/^\d{6}$/));
  });

  it('changes the password with the right code and clears the code', async () => {
    const { svc, prisma } = setup();
    const resetCodeHash = await bcrypt.hash('654321', 4);
    prisma.user.findUnique.mockResolvedValue({ id: 'u', resetCodeHash, resetExpiresAt: new Date(Date.now() + 60_000), resetAttempts: 0 });

    await svc.resetPassword({ email: 'a@b.c', code: '654321', newPassword: 'newpassword1' });

    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.resetCodeHash).toBeNull();
    expect(await bcrypt.compare('newpassword1', data.passwordHash)).toBe(true);
  });

  it('rejects wrong or expired codes with one generic message', async () => {
    const { svc, prisma } = setup();
    const resetCodeHash = await bcrypt.hash('654321', 4);

    prisma.user.findUnique.mockResolvedValue({ id: 'u', resetCodeHash, resetExpiresAt: new Date(Date.now() + 60_000), resetAttempts: 0 });
    await expect(svc.resetPassword({ email: 'a@b.c', code: '111111', newPassword: 'newpassword1' })).rejects.toThrow('Invalid or expired code');

    prisma.user.findUnique.mockResolvedValue({ id: 'u', resetCodeHash, resetExpiresAt: new Date(Date.now() - 1000), resetAttempts: 0 });
    await expect(svc.resetPassword({ email: 'a@b.c', code: '654321', newPassword: 'newpassword1' })).rejects.toBeInstanceOf(BadRequestException);

    prisma.user.findUnique.mockResolvedValue(null);
    await expect(svc.resetPassword({ email: 'x@b.c', code: '654321', newPassword: 'newpassword1' })).rejects.toThrow('Invalid or expired code');
  });

  it('burns the reset code after 5 wrong attempts', async () => {
    const { svc, prisma } = setup();
    const resetCodeHash = await bcrypt.hash('654321', 4);
    prisma.user.findUnique.mockResolvedValue({ id: 'u', resetCodeHash, resetExpiresAt: new Date(Date.now() + 60_000), resetAttempts: 4 });
    await expect(svc.resetPassword({ email: 'a@b.c', code: '111111', newPassword: 'newpassword1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ resetAttempts: 0, resetCodeHash: null, resetExpiresAt: null, codeFailures: { increment: 1 } });
  });
});

describe('IdentityService per-account limits', () => {
  const future = () => new Date(Date.now() + 60_000);
  const hash = (v: string) => bcrypt.hash(v, 4);

  it('locks the account after 5 wrong passwords and then refuses even the right one', async () => {
    const { svc, prisma } = setup();
    const passwordHash = await hash('rightpass1');
    prisma.user.findUnique.mockResolvedValue({ id: 'u', passwordHash, isVerified: true, loginFailures: 4, loginLockedUntil: null });
    prisma.user.update.mockResolvedValue({ loginFailures: 5 });

    await expect(svc.login({ email: 'a@b.c', password: 'wrong' })).rejects.toThrow('Invalid email or password');
    const lockCall = prisma.user.update.mock.calls[1][0];
    expect(lockCall.data.loginFailures).toBe(0);
    expect(lockCall.data.loginLockedUntil).toBeInstanceOf(Date);

    prisma.user.findUnique.mockResolvedValue({ id: 'u', passwordHash, isVerified: true, loginFailures: 0, loginLockedUntil: future() });
    await expect(svc.login({ email: 'a@b.c', password: 'rightpass1' })).rejects.toMatchObject({ status: 429 });
  });

  it('clears the failure count after a good login', async () => {
    const { svc, prisma } = setup();
    const passwordHash = await hash('rightpass1');
    prisma.user.findUnique.mockResolvedValue({ id: 'u', email: 'a@b.c', fullName: 'A', passwordHash, isVerified: true, loginFailures: 3, loginLockedUntil: null });
    const out = await svc.login({ email: 'a@b.c', password: 'rightpass1' });
    expect(out.accessToken).toBe('token');
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u' }, data: { loginFailures: 0, loginLockedUntil: null } });
  });

  it('locks the code flows after 10 wrong codes across several codes, and burns the live code', async () => {
    const { svc, prisma } = setup();
    const resetCodeHash = await hash('654321');
    prisma.user.findUnique.mockResolvedValue({ id: 'u', resetCodeHash, resetExpiresAt: future(), resetAttempts: 1, codeFailures: 9, codeLockedUntil: null });
    prisma.user.update.mockResolvedValueOnce({ codeFailures: 10 });

    await expect(svc.resetPassword({ email: 'a@b.c', code: '111111', newPassword: 'newpassword1' })).rejects.toThrow('Invalid or expired code');
    const lock = prisma.user.update.mock.calls[1][0].data;
    expect(lock.codeLockedUntil).toBeInstanceOf(Date);
    expect(lock.resetCodeHash).toBeNull();
  });

  it('refuses the right reset code while the account is locked', async () => {
    const { svc, prisma } = setup();
    const resetCodeHash = await hash('654321');
    prisma.user.findUnique.mockResolvedValue({ id: 'u', resetCodeHash, resetExpiresAt: future(), resetAttempts: 0, codeLockedUntil: future() });
    await expect(svc.resetPassword({ email: 'a@b.c', code: '654321', newPassword: 'newpassword1' })).rejects.toThrow('Invalid or expired code');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('does not email a second reset code within a minute, but answers the same', async () => {
    const { svc, prisma, email } = setup();
    // code issued 5s ago: expires in 15min minus 5s
    prisma.user.findUnique.mockResolvedValue({ id: 'u', isVerified: true, resetExpiresAt: new Date(Date.now() + 15 * 60_000 - 5_000) });
    const out = await svc.forgotPassword({ email: 'a@b.c' });
    expect(out.message).toMatch(/If an account exists/);
    expect(email.sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rate-limits resend-otp to one code a minute', async () => {
    const { svc, prisma, email } = setup();
    prisma.user.findUnique.mockResolvedValue({ id: 'u', isVerified: false, otpExpiresAt: new Date(Date.now() + 10 * 60_000 - 5_000) });
    await expect(svc.resendOtp({ email: 'a@b.c' })).rejects.toMatchObject({ status: 429 });
    expect(email.sendOtpEmail).not.toHaveBeenCalled();
  });
});
