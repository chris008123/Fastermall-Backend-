import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Usage in a controller: @CurrentUser() user
export const CurrentUser = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});
