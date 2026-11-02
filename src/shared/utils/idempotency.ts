import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const MAX_KEY_LENGTH = 255;

// Reads the optional Idempotency-Key header. An empty header counts as none.
export function parseIdempotencyKey(raw?: string | string[]): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const key = value?.trim();
  if (!key) return undefined;
  if (key.length > MAX_KEY_LENGTH) {
    throw new BadRequestException(
      `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`,
    );
  }
  return key;
}

// True when Prisma rejected a write because a unique constraint already holds
// the value (e.g. two retries of the same order arriving at the same moment).
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
