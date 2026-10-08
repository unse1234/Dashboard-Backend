import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { AllowUnverified } from '../common/decorators/allow-unverified.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { toPublicUser, type PublicUser } from '../users/public-user';
import { AuthService, type AuthResponse } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/recovery.dto';
import { RecoveryService } from './recovery.service';
import { RefreshCookieService } from './refresh-cookie.service';
import {
  RefreshRaceException,
  SessionsService,
  type SessionMeta,
  type SessionSummary,
} from './sessions.service';

const MINUTE_MS = 60_000;

// Account self-service stays reachable before the email is verified.
@AllowUnverified()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly cookies: RefreshCookieService,
    private readonly recovery: RecoveryService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const result = await this.auth.login(dto, this.sessionMeta(request));
    this.cookies.set(response, result.refreshToken);
    return result.body;
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const refreshToken = this.cookies.read(request);
    if (!refreshToken) throw new UnauthorizedException('Invalid refresh token');

    try {
      const result = await this.auth.refresh(
        refreshToken,
        this.sessionMeta(request),
      );
      this.cookies.set(response, result.refreshToken);
      return result.body;
    } catch (error) {
      // A lost race means a sibling request already set the new cookie; clearing
      // it here would sign the user out.
      if (!(error instanceof RefreshRaceException))
        this.cookies.clear(response);
      throw error;
    }
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(this.cookies.read(request));
    this.cookies.clear(response);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): PublicUser {
    return toPublicUser(user);
  }

  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Patch('change-password')
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(user, dto);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('forgot-password')
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<{ message: string }> {
    await this.recovery.requestPasswordReset(dto.email);
    // Identical for known and unknown addresses.
    return {
      message:
        'If an account exists for that email address, a password reset link has been sent.',
    };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  async resetPassword(
    @Body() dto: ResetPasswordDto,
  ): Promise<{ message: string }> {
    await this.recovery.resetPassword(dto.token, dto.password);
    return { message: 'Your password has been reset. You can now sign in.' };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-email')
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ message: string }> {
    await this.recovery.verifyEmail(dto.token);
    return { message: 'Your email address has been verified.' };
  }

  @Throttle({ default: { limit: 3, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('resend-verification')
  async resendVerification(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ message: string }> {
    await this.recovery.resendVerification(user);
    return {
      message:
        'If your email address is not yet verified, a new verification link has been sent.',
    };
  }

  @Get('sessions')
  listSessions(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SessionSummary[]> {
    return this.sessions.listForUser(user.id, user.sessionId);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('sessions/:id')
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.sessions.revokeOwned(user.id, id);
  }

  private sessionMeta(request: Request): SessionMeta {
    return {
      ipAddress: request.ip,
      userAgent: request.get('user-agent')?.slice(0, 255),
    };
  }
}
