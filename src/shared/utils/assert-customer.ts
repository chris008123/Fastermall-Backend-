import { ForbiddenException } from '@nestjs/common';

// Staff accounts share the JWT format but live in a different table. Routes
// that act on a customer's own data call this first.
export function assertCustomer(user: { role?: string }) {
  if (user.role !== 'CUSTOMER') {
    throw new ForbiddenException('Only customer accounts can use this route');
  }
}
