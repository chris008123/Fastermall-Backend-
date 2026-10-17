import { HttpException, HttpStatus } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

// Per-account limits. The per-IP throttler still runs; these hold even when an
// attacker rotates IP addresses.
export const MAX_LOGIN_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

// Wrong codes counted across ALL codes issued to an account (requesting a new
// code does not reset it), then the code flows are shut for a while.
export const MAX_TOTAL_CODE_FAILURES = 10;
export const CODE_LOCK_MS = 60 * 60 * 1000;

// Minimum gap between two emailed codes for the same account.
export const CODE_COOLDOWN_MS = 60 * 1000;

// Compared against when the account doesn't exist, so a missing account and a
// wrong password take about the same time.
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password', 10);

export const isLocked = (until?: Date | null): boolean =>
  !!until && until.getTime() > Date.now();

// True if a code was emailed less than CODE_COOLDOWN_MS ago. The issue time is
// worked out from the expiry, so no extra column is needed.
export const issuedRecently = (
  expiresAt: Date | null | undefined,
  ttlMs: number,
): boolean =>
  !!expiresAt && Date.now() - (expiresAt.getTime() - ttlMs) < CODE_COOLDOWN_MS;

export const tooManyAttempts = (
  message = 'Too many attempts. Please try again later.',
) => new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
