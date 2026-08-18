import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

import { AnalyticsService } from '../analytics/analytics.service';
import { AuthService } from '../auth/auth.service';
import { RateLimit, RateLimitGuard } from '../hardening/rate-limit.guard';

export class SignupDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @MinLength(10) password!: string;
  @IsBoolean() ageAttested!: boolean;
}

export class LoginDto {
  @IsString() contact!: string;
  @IsString() password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly analytics: AnalyticsService,
  ) {}

  @Post('signup')
  @UseGuards(RateLimitGuard)
  @RateLimit('auth')
  async signup(@Body() body: SignupDto) {
    try {
      const result = await this.auth.signup({
        ...(body.email === undefined ? {} : { email: body.email }),
        ...(body.phone === undefined ? {} : { phone: body.phone }),
        password: body.password,
        ageAttested: body.ageAttested,
      });
      // The top of §6.8's funnel. Best-effort, like every analytics write.
      await this.analytics.record('signup', { tier: result.tier }, result.userId);
      return result;
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @Post('login')
  @UseGuards(RateLimitGuard)
  @RateLimit('auth')
  async login(@Body() body: LoginDto) {
    try {
      return await this.auth.login(body);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
}
