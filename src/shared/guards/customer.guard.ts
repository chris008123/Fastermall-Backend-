import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { assertCustomer } from '../utils/assert-customer';

// Attach after JwtAuthGuard on routes that act on a customer's own data
// (orders, payments, pre-orders...). Staff tokens are refused with a clear
// 403 instead of failing later in the database with a 500.
@Injectable()
export class CustomerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest();
    assertCustomer(user ?? {});
    return true;
  }
}
