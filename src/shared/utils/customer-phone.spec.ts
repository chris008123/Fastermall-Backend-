import { DeliveryStatus } from '@prisma/client';
import { customerPhoneVisible, withCustomerPhoneRule } from './customer-phone';

const delivery = (partnerId: string | null, status: DeliveryStatus) => ({
  id: 'd1',
  partnerId,
  status,
  order: { id: 'o1', customer: { id: 'c1', fullName: 'Ama Mensah', phone: '0241234567' } },
});

describe('customer phone for delivery partners', () => {
  it('is hidden on an open job nobody has taken', () => {
    const out = withCustomerPhoneRule(delivery(null, DeliveryStatus.ASSIGNED));
    expect(out.order.customer).toEqual({ id: 'c1', fullName: 'Ama Mensah' });
  });

  it('is shown while the partner is carrying the order', () => {
    for (const s of [
      DeliveryStatus.ASSIGNED,
      DeliveryStatus.EN_ROUTE_TO_PICKUP,
      DeliveryStatus.PAY_VENDOR,
      DeliveryStatus.PICKED_UP,
      DeliveryStatus.EN_ROUTE_TO_CUSTOMER,
    ]) {
      expect(withCustomerPhoneRule(delivery('p1', s)).order.customer.phone).toBe('0241234567');
    }
  });

  it('is hidden again once the delivery is over', () => {
    expect(customerPhoneVisible({ partnerId: 'p1', status: DeliveryStatus.DELIVERED })).toBe(false);
    expect(customerPhoneVisible({ partnerId: 'p1', status: DeliveryStatus.FAILED })).toBe(false);
    expect(withCustomerPhoneRule(delivery('p1', DeliveryStatus.DELIVERED)).order.customer).not.toHaveProperty('phone');
  });

  it('leaves deliveries without a customer alone', () => {
    const d = { partnerId: 'p1', status: DeliveryStatus.PICKED_UP, order: null };
    expect(withCustomerPhoneRule(d)).toBe(d);
  });
});
