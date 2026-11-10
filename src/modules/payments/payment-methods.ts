import { BadRequestException } from '@nestjs/common';

/**
 * The payment methods customers can choose. Cash was removed (Nov 2026):
 * every order is paid online. `CASH` stays in the PaymentMethod enum only
 * because older payments in the database use it.
 */
export const ACCEPTED_PAYMENT_METHODS = ['MOBILE_MONEY', 'CARD'] as const;
export type AcceptedPaymentMethod = (typeof ACCEPTED_PAYMENT_METHODS)[number];

export const CASH_REMOVED_MESSAGE =
  'Cash payment is no longer available. Please pay with mobile money or card.';

/**
 * Checks the payment method label an order is placed with. The label is only
 * a hint (the real method is chosen at POST /payments/initialize), but any
 * cash choice ("CASH", "cash on delivery", ...) is refused. Known online
 * methods are stored in their canonical form; other labels pass through.
 */
export function normalizeOrderPaymentMethod(value?: string | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/cash/i.test(trimmed)) throw new BadRequestException(CASH_REMOVED_MESSAGE);
  const canonical = trimmed.toUpperCase().replace(/[\s-]+/g, '_');
  return (ACCEPTED_PAYMENT_METHODS as readonly string[]).includes(canonical) ? canonical : trimmed;
}
