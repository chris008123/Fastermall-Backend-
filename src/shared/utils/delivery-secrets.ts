import { Prisma } from '@prisma/client';

// The customer's handover code is stored as a bcrypt hash plus an encrypted
// copy. Neither may leave the server: a 6-digit code's hash can be cracked
// offline in minutes, and whoever learns the code can mark a delivery as
// handed over without meeting the customer.
const SECRET_KEYS = [
  'deliveryCodeHash',
  'deliveryCodeEncrypted',
  'deliveryCodeAttempts',
  'deliveryCodeLockedUntil',
] as const;

type SecretKey = (typeof SECRET_KEYS)[number];

/** Copy of a delivery row without the handover-code secrets. */
export function stripDeliverySecrets<T extends object>(delivery: T): Omit<T, SecretKey & keyof T> {
  const out = { ...delivery } as Record<string, unknown>;
  for (const key of SECRET_KEYS) delete out[key];
  return out as Omit<T, SecretKey & keyof T>;
}

/** Same, for a list. */
export function stripDeliveriesSecrets<T extends object>(rows: T[]): Omit<T, SecretKey & keyof T>[] {
  return rows.map(stripDeliverySecrets);
}

/**
 * Prisma select for a delivery's own columns, minus the secrets. Use this
 * when a delivery is nested inside another record (order, laundry order).
 */
export const SAFE_DELIVERY_SELECT = {
  id: true,
  orderId: true,
  laundryOrderId: true,
  partnerId: true,
  claimedByStaffId: true,
  status: true,
  pickupLat: true,
  pickupLng: true,
  dropoffLat: true,
  dropoffLng: true,
  distanceKm: true,
  deliveryCodeUsed: true,
  verifiedAt: true,
  riderLat: true,
  riderLng: true,
  riderLocationAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DeliverySelect;
