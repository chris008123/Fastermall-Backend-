import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IdentityService } from './identity.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { GoogleLoginDto } from './dto/google-login.dto';


// Sensitive routes get a much stricter limit than the global default.
const STRICT = { default: { limit: 5, ttl: 60_000 } };

@Controller('auth')
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Throttle(STRICT)
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.identityService.register(dto);
  }

  @Throttle(STRICT)
  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.identityService.verifyOtp(dto);
  }

  @Throttle(STRICT)
  @Post('resend-otp')
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.identityService.resendOtp(dto);
  }

  @Throttle(STRICT)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.identityService.login(dto);
  }

  @Throttle(STRICT)
  @Post('google')
  google(@Body() dto: GoogleLoginDto) {
    return this.identityService.loginWithGoogle(dto);
  }

  @Throttle(STRICT)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.identityService.forgotPassword(dto);
  }

  @Throttle(STRICT)
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.identityService.resetPassword(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: { userId: string }) {
    return this.identityService.getProfile(user.userId);
  }
}
