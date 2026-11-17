import { OrderStatus } from '@prisma/client';

/**
 * Which status changes an admin may make with PATCH /orders/:id/status.
 *
 * - Orders only move forward: PENDING → CONFIRMED → PREPARING →
 *   OUT_FOR_DELIVERY → DELIVERED (skipping ahead is allowed, going back isn't).
 * - CANCELLED is allowed until the order is delivered.
 * - REFUNDED is never set by hand. Money going back is recorded on the payment
 *   (POST /payments/:id/refund); an order marked refunded with no refund
 *   behind it would make the books say money went back when it didn't.
 * - DELIVERED, CANCELLED and REFUNDED are final: a closed order can't be reopened.
 * - Saving the status it already has is a no-op (a double tap in the console).
 */
export const ORDER_FLOW: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

export const FINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
];

export type StatusChangeCheck =
  | { ok: true; noop: boolean }
  | { ok: false; code: 'REFUND_ON_PAYMENT' | 'ORDER_CLOSED' | 'INVALID_STATUS_CHANGE'; message: string; allowed: OrderStatus[] };

/** What an admin could change this order to from `from`. */
export function allowedOrderStatuses(from: OrderStatus): OrderStatus[] {
  if (FINAL_ORDER_STATUSES.includes(from)) return [];
  const i = ORDER_FLOW.indexOf(from);
  return [...ORDER_FLOW.slice(i + 1), OrderStatus.CANCELLED];
}

export function checkOrderStatusChange(from: OrderStatus, to: OrderStatus): StatusChangeCheck {
  if (from === to) return { ok: true, noop: true };
  const allowed = allowedOrderStatuses(from);
  if (to === OrderStatus.REFUNDED) {
    return {
      ok: false,
      code: 'REFUND_ON_PAYMENT',
      message: 'An order is not marked refunded by hand. Refund its payment instead (POST /payments/:id/refund).',
      allowed,
    };
  }
  if (FINAL_ORDER_STATUSES.includes(from)) {
    return { ok: false, code: 'ORDER_CLOSED', message: `This order is ${from.toLowerCase()} and can't be changed.`, allowed };
  }
  if (!allowed.includes(to)) {
    return {
      ok: false,
      code: 'INVALID_STATUS_CHANGE',
      message: `An order can't go from ${from.toLowerCase()} back to ${to.toLowerCase()}.`,
      allowed,
    };
  }
  return { ok: true, noop: false };
}
