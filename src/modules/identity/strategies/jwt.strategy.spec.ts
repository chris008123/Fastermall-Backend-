import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';

function makeStrategy(staff: { isActive: boolean } | null) {
  const findUnique = jest.fn().mockResolvedValue(staff);
  const prisma = { staffUser: { findUnique } } as any;
  const config = { get: () => 'test-secret' } as unknown as ConfigService;
  return { strategy: new JwtStrategy(config, prisma), findUnique };
}

describe('JwtStrategy.validate', () => {
  it('accepts customer tokens without looking up a staff account', async () => {
    const { strategy, findUnique } = makeStrategy(null);
    await expect(
      strategy.validate({ sub: 'cust-1', email: 'c@x.com', role: 'CUSTOMER' }),
    ).resolves.toEqual({ userId: 'cust-1', email: 'c@x.com', role: 'CUSTOMER' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('accepts an active staff token', async () => {
    const { strategy } = makeStrategy({ isActive: true });
    await expect(
      strategy.validate({ sub: 'staff-1', email: 's@x.com', role: 'ADMIN' }),
    ).resolves.toEqual({ userId: 'staff-1', email: 's@x.com', role: 'ADMIN' });
  });

  it('rejects a deactivated staff token', async () => {
    const { strategy } = makeStrategy({ isActive: false });
    await expect(
      strategy.validate({ sub: 'staff-1', email: 's@x.com', role: 'ADMIN' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a staff token whose account was deleted', async () => {
    const { strategy } = makeStrategy(null);
    await expect(
      strategy.validate({ sub: 'gone', email: 's@x.com', role: 'DELIVERY_PARTNER' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
