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
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ otpAttempts: 3 });

    prisma.user.findUnique.mockResolvedValue({ id: 'u', isVerified: false, otpCodeHash, otpExpiresAt: future, otpAttempts: 4 });
    await expect(svc.verifyOtp({ email: 'a@b.c', code: '000000' })).rejects.toThrow(/Too many incorrect attempts/);
    expect(prisma.user.update.mock.calls[1][0].data).toEqual({ otpAttempts: 0, otpCodeHash: null, otpExpiresAt: null });
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
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ resetAttempts: 0, resetCodeHash: null, resetExpiresAt: null });
  });
});
