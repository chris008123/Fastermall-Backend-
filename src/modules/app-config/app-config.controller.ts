import { Controller, Get, Header, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { AppConfigService, AppName } from './app-config.service';

class AppConfigQueryDto {
  @IsOptional()
  @IsIn(['partner', 'customer'])
  app?: AppName;

  // The app's own version, e.g. 1.4.2. Lets the server say if an update is required.
  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d+){0,3}(-[A-Za-z0-9.]+)?$/, { message: 'version must look like 1.4.2' })
  version?: string;
}

// No sign-in needed: the app asks before the partner has logged in.
@Controller('app')
export class AppConfigController {
  constructor(private readonly appConfig: AppConfigService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'public, max-age=60')
  @Get('config')
  get(@Query() q: AppConfigQueryDto) {
    return this.appConfig.get(q.app ?? 'partner', q.version);
  }
}
