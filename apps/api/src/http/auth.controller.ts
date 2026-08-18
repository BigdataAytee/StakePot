import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

import { AuthService } from '../auth/auth.service';

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
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  async signup(@Body() body: SignupDto) {
    try {
      return await this.auth.signup({
        ...(body.email === undefined ? {} : { email: body.email }),
        ...(body.phone === undefined ? {} : { phone: body.phone }),
        password: body.password,
        ageAttested: body.ageAttested,
      });
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @Post('login')
  async login(@Body() body: LoginDto) {
    try {
      return await this.auth.login(body);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
}
