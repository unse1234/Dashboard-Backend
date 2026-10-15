import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RecoveryService } from './recovery.service';
import { RefreshCookieService } from './refresh-cookie.service';
import { RefreshRaceException, SessionsService } from './sessions.service';

describe('refresh cookie recovery', () => {
  const auth = { refresh: jest.fn() };
  const cookies = {
    read: jest.fn(() => 'existing-refresh-cookie'),
    clear: jest.fn(),
    set: jest.fn(),
  };
  const request = { ip: '127.0.0.1', get: () => 'test' } as unknown as Request;
  const response = {} as Response;
  let controller: AuthController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: RefreshCookieService, useValue: cookies },
        { provide: SessionsService, useValue: {} },
        { provide: RecoveryService, useValue: {} },
      ],
    })
      .overrideGuard(CsrfGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(AuthController);
  });

  it.each([
    new Error('Database connection timed out'),
    new ServiceUnavailableException('Database unavailable'),
    new RefreshRaceException('Another tab refreshed'),
  ])('preserves the cookie when retrying may recover: %s', async (error) => {
    auth.refresh.mockRejectedValue(error);

    await expect(controller.refresh(request, response)).rejects.toBe(error);
    expect(cookies.clear).not.toHaveBeenCalled();
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('clears a rejected refresh credential', async () => {
    auth.refresh.mockRejectedValue(new UnauthorizedException('Invalid token'));

    await expect(controller.refresh(request, response)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(cookies.clear).toHaveBeenCalledWith(response);
  });
});
