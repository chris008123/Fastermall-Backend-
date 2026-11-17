import { NotFoundException } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { AdminController } from './admin.controller';
import { PaymentsController } from '../payments/payments.controller';
import { PreOrdersService } from '../preorders/preorders.service';
import { IdempotencyInterceptor } from '../../shared/interceptors/idempotency.interceptor';

// Money actions in the admin console are safe to retry: a repeat with the same
// Idempotency-Key replays the first answer instead of doing it twice.
describe('admin money actions honour Idempotency-Key', () => {
  const interceptors = (fn: unknown) => Reflect.getMetadata(INTERCEPTORS_METADATA, fn as object) ?? [];

  it('recording a partner payout', () => {
    expect(interceptors(AdminController.prototype.createPayout)).toContain(IdempotencyInterceptor);
  });

  it('refunding a payment', () => {
    expect(interceptors(PaymentsController.prototype.refund)).toContain(IdempotencyInterceptor);
  });
});

describe('PreOrdersService.listVariants (admin)', () => {
  function setup(product: unknown) {
    const prisma: any = {
      product: { findUnique: jest.fn().mockResolvedValue(product) },
      productVariant: { findMany: jest.fn().mockResolvedValue([{ id: 'v1', isActive: false }]) },
    };
    return { svc: new PreOrdersService(prisma, {} as any, { get: () => undefined } as any, { emit: jest.fn() } as any), prisma };
  }

  it('includes switched-off designs, so an admin can switch them back on', async () => {
    const { svc, prisma } = setup({ id: 'p1' });
    expect(await svc.listVariants('p1')).toEqual([{ id: 'v1', isActive: false }]);
    expect(prisma.productVariant.findMany.mock.calls[0][0].where).toEqual({ productId: 'p1' });
  });

  it('404 for an unknown product', async () => {
    const { svc } = setup(null);
    await expect(svc.listVariants('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
