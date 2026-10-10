import { Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { changePasswordSchema, forgotPasswordSchema, loginSchema, mfaCodeSchema, resetPasswordSchema } from '@medigest/shared';
import type { Request, Response } from 'express';
import { config } from '../../config';
import { AuthUser } from '../../common/context';
import { AllowPending, CurrentUser, Public } from '../../common/decorators';
import { ApiZBody, ZBody } from '../../common/zod.pipe';
import { AuthService } from './auth.service';
import { SESSION_COOKIE, SessionService } from './session.service';

function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProduction,
    path: '/',
    maxAge: config.SESSION_ABSOLUTE_HOURS * 3600_000,
  });
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Throttle({ default: { limit: config.LOGIN_RATE_LIMIT, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  @ApiZBody(loginSchema)
  async login(@ZBody(loginSchema) body: { email: string; password: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { token, mfaRequired } = await this.auth.login(body.email, body.password, req.ip, req.get('user-agent'));
    setSessionCookie(res, token);
    return { ok: true, mfaRequired };
  }

  @AllowPending()
  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @AllowPending()
  @Get('me')
  async me(@CurrentUser() user: AuthUser, @Req() req: Request & { cookies: Record<string, string> }) {
    const resolved = await this.sessions.resolve(req.cookies[SESSION_COOKIE]);
    return this.auth.me(user, resolved?.mfaPending ?? false);
  }

  @AllowPending()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/verify')
  @HttpCode(200)
  @ApiZBody(mfaCodeSchema)
  async verifyMfa(@CurrentUser() user: AuthUser, @ZBody(mfaCodeSchema) body: { code: string }) {
    await this.auth.verifyMfa(user, body.code);
    return { ok: true };
  }

  @AllowPending()
  @Post('mfa/setup')
  @HttpCode(200)
  setupMfa(@CurrentUser() user: AuthUser) {
    return this.auth.setupMfa(user);
  }

  @AllowPending()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/enable')
  @HttpCode(200)
  @ApiZBody(mfaCodeSchema)
  async enableMfa(@CurrentUser() user: AuthUser, @ZBody(mfaCodeSchema) body: { code: string }) {
    await this.auth.enableMfa(user, body.code);
    return { ok: true };
  }

  @AllowPending()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('password/change')
  @HttpCode(200)
  @ApiZBody(changePasswordSchema)
  async changePassword(@CurrentUser() user: AuthUser, @ZBody(changePasswordSchema) body: { currentPassword: string; newPassword: string }) {
    await this.auth.changePassword(user, body.currentPassword, body.newPassword);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/forgot')
  @HttpCode(200)
  @ApiZBody(forgotPasswordSchema)
  async forgot(@ZBody(forgotPasswordSchema) body: { email: string }) {
    await this.auth.forgotPassword(body.email);
    return { ok: true, message: 'Si el correo está registrado, recibirá instrucciones para restablecer la contraseña.' };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('password/reset')
  @HttpCode(200)
  @ApiZBody(resetPasswordSchema)
  async reset(@ZBody(resetPasswordSchema) body: { token: string; newPassword: string }) {
    await this.auth.resetPassword(body.token, body.newPassword);
    return { ok: true };
  }
}
