import { DeliveryStatus } from '@prisma/client';

// A delivery partner may call the customer only while carrying their order.
// The phone is sent once a partner has the delivery and until it ends; an
// open job (no partner yet) or a finished one never carries it. Partners can
// only open their own deliveries or open jobs, so "has a partner" means "is
// the caller's" for them; admins see it for support.

const FINISHED: DeliveryStatus[] = [DeliveryStatus.DELIVERED, DeliveryStatus.FAILED];

type WithCustomer = { customer?: ({ phone?: string | null } & Record<string, unknown>) | null } | null | undefined;

export function customerPhoneVisible(delivery: { partnerId?: string | null; status: DeliveryStatus }): boolean {
  return Boolean(delivery.partnerId) && !FINISHED.includes(delivery.status);
}

/** Removes order.customer.phone unless the partner may call the customer now. */
export function withCustomerPhoneRule<
  T extends { partnerId?: string | null; status: DeliveryStatus; order?: WithCustomer },
>(delivery: T): T {
  const customer = delivery.order?.customer;
  if (!customer || !('phone' in customer) || customerPhoneVisible(delivery)) return delivery;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { phone, ...rest } = customer;
  return { ...delivery, order: { ...delivery.order!, customer: rest } };
}
