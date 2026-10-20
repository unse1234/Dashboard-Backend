import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  RefreshRaceException,
  type SessionMeta,
} from '../auth/sessions.service';
import { Public } from '../common/decorators/public.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import {
  AccountOrdersQueryDto,
  AccountSetupDto,
  RequestSetupLinkDto,
  SetupTokenDto,
  StorefrontForgotPasswordDto,
  StorefrontResetPasswordDto,
  StorefrontSignInDto,
} from './dto/storefront-account.dto';
import type {
  StorefrontAccountOrder,
  StorefrontAccountOrderPage,
} from './storefront-account-orders';
import { StorefrontAccountOrdersService } from './storefront-account-orders.service';
import {
  PASSWORD_RESET_REQUESTED,
  SETUP_LINK_REQUESTED,
  StorefrontAccountRecoveryService,
} from './storefront-account-recovery.service';
import {
  StorefrontAccountsService,
  toAccountView,
  type AccountSetupPreview,
  type StorefrontAccountView,
  type StorefrontAuthResponse,
} from './storefront-accounts.service';
import {
  CurrentStorefrontAccount,
  StorefrontAccountsEnabledGuard,
  StorefrontAuthGuard,
  type AuthenticatedStorefrontAccount,
} from './storefront-auth.guard';
import { StorefrontRefreshCookieService } from './storefront-refresh-cookie.service';

const MINUTE_MS = 60_000;

/**
 * Storefront (shopper) accounts. @Public() for the staff guards: no staff
 * token is needed here and none is accepted where a shopper must be signed
 * in, which StorefrontAuthGuard decides with the storefront key alone. Every
 * route is a 404 while STOREFRONT_ACCOUNTS_ENABLED is false.
 *
 * Tokens travel in request bodies (setup, reset) or the HttpOnly cookie
 * (refresh), never in a URL. The cookie routes follow the staff conventions:
 * CsrfGuard on refresh and sign-out, rotation on every refresh, and a cookie
 * cleared only when the credential is known to be bad.
 */
@Public()
@UseGuards(StorefrontAccountsEnabledGuard)
@Controller('storefront/account')
export class StorefrontAccountsController {
  constructor(
    private readonly accounts: StorefrontAccountsService,
    private readonly recovery: StorefrontAccountRecoveryService,
    private readonly orders: StorefrontAccountOrdersService,
    private readonly cookies: StorefrontRefreshCookieService,
  ) {}

  /** What a setup permission allows, for the setup page. Reads only. */
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('setup/preview')
  previewSetup(@Body() dto: SetupTokenDto): Promise<AccountSetupPreview> {
    return this.accounts.previewSetup(dto.setupToken);
  }

  /** Creates the account for the permission's address and signs it in. */
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.CREATED)
  @Post('setup')
  async setup(
    @Body() dto: AccountSetupDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StorefrontAuthResponse> {
    const result = await this.accounts.setup(dto, sessionMeta(request));
    this.cookies.set(response, result.refreshToken);
    return result.body;
  }

  /** Emails a new setup link; the same answer whatever the address. */
  @Throttle({ default: { limit: 3, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('setup-link')
  async requestSetupLink(
    @Body() dto: RequestSetupLinkDto,
  ): Promise<{ message: string }> {
    await this.recovery.requestSetupLink(dto);
    return { message: SETUP_LINK_REQUESTED };
  }

  /** Sign in. */
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('session')
  async signIn(
    @Body() dto: StorefrontSignInDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StorefrontAuthResponse> {
    const result = await this.accounts.signIn(dto, sessionMeta(request));
    this.cookies.set(response, result.refreshToken);
    return result.body;
  }

  @UseGuards(CsrfGuard)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('session/refresh')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StorefrontAuthResponse> {
    const refreshToken = this.cookies.read(request);
    if (!refreshToken) throw new UnauthorizedException('Invalid refresh token');
    try {
      const result = await this.accounts.refresh(
        refreshToken,
        sessionMeta(request),
      );
      this.cookies.set(response, result.refreshToken);
      return result.body;
    } catch (error) {
      // Only a bad credential clears the cookie: a database outage says
      // nothing about it, and a sibling that won the race set a fresh one.
      if (
        error instanceof UnauthorizedException &&
        !(error instanceof RefreshRaceException)
      ) {
        this.cookies.clear(response);
      }
      throw error;
    }
  }

  @UseGuards(CsrfGuard)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('session/sign-out')
  async signOut(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.accounts.signOut(this.cookies.read(request));
    this.cookies.clear(response);
  }

  /** The signed-in shopper's account. */
  @UseGuards(StorefrontAuthGuard)
  @Get('me')
  me(
    @CurrentStorefrontAccount() account: AuthenticatedStorefrontAccount,
  ): StorefrontAccountView {
    return toAccountView(account);
  }

  /** The signed-in shopper's orders, newest first. */
  @UseGuards(StorefrontAuthGuard)
  @Get('orders')
  listOrders(
    @CurrentStorefrontAccount() account: AuthenticatedStorefrontAccount,
    @Query() query: AccountOrdersQueryDto,
  ): Promise<StorefrontAccountOrderPage> {
    return this.orders.list(account, query);
  }

  /**
   * One of the signed-in shopper's orders. The id stays a string (parsed in
   * the service, malformed ones answered like unknown ones), so the global
   * ValidationPipe never casts it.
   */
  @UseGuards(StorefrontAuthGuard)
  @Get('orders/:orderId')
  getOrder(
    @CurrentStorefrontAccount() account: AuthenticatedStorefrontAccount,
    @Param('orderId') orderId: string,
  ): Promise<StorefrontAccountOrder> {
    return this.orders.get(account, orderId);
  }

  /** Emails a reset link if the address has an account; the same answer either way. */
  @Throttle({ default: { limit: 3, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('password/forgot')
  async forgotPassword(
    @Body() dto: StorefrontForgotPasswordDto,
  ): Promise<{ message: string }> {
    await this.recovery.requestPasswordReset(dto.email);
    return { message: PASSWORD_RESET_REQUESTED };
  }

  @Throttle({ default: { limit: 10, ttl: MINUTE_MS } })
  @HttpCode(HttpStatus.OK)
  @Post('password/reset')
  async resetPassword(
    @Body() dto: StorefrontResetPasswordDto,
  ): Promise<{ message: string }> {
    await this.recovery.resetPassword(dto);
    return { message: 'Your password has been reset. You can now sign in.' };
  }
}

function sessionMeta(request: Request): SessionMeta {
  return {
    ipAddress: request.ip,
    userAgent: request.get('user-agent')?.slice(0, 255),
  };
}
