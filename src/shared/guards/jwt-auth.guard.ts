import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Attach with @UseGuards(JwtAuthGuard) on any route that requires a
// logged-in user. Populates request.user from the JWT payload.
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
