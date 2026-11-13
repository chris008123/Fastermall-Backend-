import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CustomerGuard } from './customer.guard';

const ctx = (user: unknown) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

describe('CustomerGuard', () => {
  const guard = new CustomerGuard();

  it('lets a customer through', () => {
    expect(guard.canActivate(ctx({ userId: 'u1', role: 'CUSTOMER' }))).toBe(true);
  });

  it.each(['ADMIN', 'DELIVERY_PARTNER', 'VENDOR', 'LAUNDRY_STAFF'])('refuses %s with a 403', (role) => {
    expect(() => guard.canActivate(ctx({ userId: 's1', role }))).toThrow(ForbiddenException);
  });

  it('refuses a request with no user', () => {
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });
});

describe('customer-only routes use CustomerGuard', () => {
  const { GUARDS_METADATA } = require('@nestjs/common/constants');
  const { OrdersController } = require('../../modules/orders/orders.controller');
  const { LaundryController } = require('../../modules/laundry/laundry.controller');
  const { LaundryVendorsController } = require('../../modules/laundry/laundry-vendors.controller');
  const { PaymentsController } = require('../../modules/payments/payments.controller');
  const { PreOrdersController } = require('../../modules/preorders/preorders.controller');

  const guarded = (target: object) => (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];

  it.each([
    [OrdersController, ['create', 'findMine', 'deliveryWindows', 'rescheduleDelivery', 'cancel', 'findOne']],
    [LaundryController, ['create', 'findMine']],
    [LaundryVendorsController, ['review', 'removeReview']],
    [PaymentsController, ['initialize', 'verify', 'findMine']],
  ])('%p', (controller: any, methods: string[]) => {
    for (const m of methods) expect(guarded(controller.prototype[m])).toContain(CustomerGuard);
  });

  it('the whole customer pre-orders controller', () => {
    expect(guarded(PreOrdersController)).toContain(CustomerGuard);
  });

  it('routes staff also use are left open to them', () => {
    // Laundry staff and admins open single laundry orders; admins change order status.
    expect(guarded(LaundryController.prototype.findOne)).not.toContain(CustomerGuard);
    expect(guarded(OrdersController.prototype.updateStatus)).not.toContain(CustomerGuard);
  });
});
