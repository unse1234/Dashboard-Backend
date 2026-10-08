import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { TokenService } from './token.service';

const SECRET = 's'.repeat(40);
const settings: Record<string, unknown> = {
  JWT_ISSUER: 'issuer-a',
  JWT_AUDIENCE: 'audience-a',
  JWT_ACCESS_TTL_SECONDS: 900,
};

describe('TokenService', () => {
  let service: TokenService;
  let jwt: JwtService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: SECRET,
          signOptions: {
            algorithm: 'HS256',
            expiresIn: 900,
            issuer: 'issuer-a',
            audience: 'audience-a',
          },
        }),
      ],
      providers: [
        TokenService,
        {
          provide: ConfigService,
          useValue: { getOrThrow: (key: string) => settings[key] },
        },
      ],
    }).compile();
    service = moduleRef.get(TokenService);
    jwt = moduleRef.get(JwtService);
  });

  it('round-trips subject and session id', async () => {
    const { accessToken, expiresIn } = await service.signAccessToken(
      'u1',
      's1',
    );
    expect(expiresIn).toBe(900);
    await expect(service.verifyAccessToken(accessToken)).resolves.toEqual({
      sub: 'u1',
      sid: 's1',
    });
  });

  it('rejects tampered, foreign-secret, expired and wrongly scoped tokens', async () => {
    const { accessToken } = await service.signAccessToken('u1', 's1');
    const [h, p, s] = accessToken.split('.');
    const tampered = `${h}.${Buffer.from(
      JSON.stringify({ sub: 'admin', sid: 's1' }),
    ).toString('base64url')}.${s}`;

    const foreign = new JwtService({ secret: 'x'.repeat(40) }).sign(
      { sub: 'u1', sid: 's1' },
      { issuer: 'issuer-a', audience: 'audience-a' },
    );
    const expired = jwt.sign({ sub: 'u1', sid: 's1' }, { expiresIn: -5 });
    const wrongAudience = jwt.sign(
      { sub: 'u1', sid: 's1' },
      { audience: 'other' },
    );
    const wrongIssuer = jwt.sign({ sub: 'u1', sid: 's1' }, { issuer: 'other' });
    const missingSession = jwt.sign({ sub: 'u1' });

    for (const bad of [
      tampered,
      foreign,
      expired,
      wrongAudience,
      wrongIssuer,
      missingSession,
      'garbage',
      '',
      `${h}.${p}.`,
    ]) {
      await expect(service.verifyAccessToken(bad)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });
});
