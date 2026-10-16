import 'reflect-metadata';
import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsFQDN,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum MailTransportKind {
  Console = 'console',
  Smtp = 'smtp',
}

export enum CookieSameSite {
  Strict = 'strict',
  Lax = 'lax',
  None = 'none',
}

type TransformParams = {
  value: unknown;
  obj: Record<string, unknown>;
  key: string;
};

// Both helpers read the raw env string: implicit conversion runs first and would
// turn "false" into true and "" into 0.

/** Parses `"true"`/`"false"` strings; anything else is left to fail validation. */
const toBoolean = ({ obj, key }: TransformParams): unknown => {
  const value = obj[key];
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
};

const emptyToUndefined = ({ value, obj, key }: TransformParams): unknown => {
  const raw = obj[key];
  return typeof raw === 'string' && raw.trim() === '' ? undefined : value;
};

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3001;

  /** Storage outside src/dist; resolved against the backend working directory. */
  @IsString()
  @IsNotEmpty()
  UPLOAD_DIR: string = './uploads';

  /** Public API origin; never inferred from the incoming Host header. */
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  PUBLIC_API_URL?: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  /** Bounds both opening a database connection and waiting for a pool slot. */
  @IsInt()
  @Min(100)
  @Max(60_000)
  DB_CONNECTION_TIMEOUT_MS: number = 5_000;

  /** Server-side statement deadline, including time waiting on database locks. */
  @IsInt()
  @Min(100)
  @Max(120_000)
  DB_QUERY_TIMEOUT_MS: number = 10_000;

  /** Per-request duration headers and redacted slow-request summaries. */
  @Transform(toBoolean)
  @IsBoolean()
  REQUEST_TIMING_ENABLED: boolean = true;

  @IsInt()
  @Min(0)
  @Max(120_000)
  SLOW_REQUEST_THRESHOLD_MS: number = 500;

  /** Comma-separated list of exact origins allowed for CORS and CSRF checks. */
  @IsString()
  @IsNotEmpty()
  CORS_ORIGINS!: string;

  /** Base URL of the dashboard, used to build links in emails. */
  @IsUrl({ require_tld: false, require_protocol: true })
  FRONTEND_URL!: string;

  /** Number of reverse proxies in front of the app (0 disables `trust proxy`). */
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY: number = 0;

  @IsString()
  @MinLength(32, {
    message: 'JWT_ACCESS_SECRET must be at least 32 characters long',
  })
  JWT_ACCESS_SECRET!: string;

  @IsInt()
  @Min(60)
  @Max(3600)
  JWT_ACCESS_TTL_SECONDS: number = 900;

  @IsString()
  @IsNotEmpty()
  JWT_ISSUER: string = 'ecom-dash-api';

  @IsString()
  @IsNotEmpty()
  JWT_AUDIENCE: string = 'ecom-dash-dashboard';

  /** Disabling is for automated tests only; production refuses to start without it. */
  @Transform(toBoolean)
  @IsBoolean()
  RATE_LIMIT_ENABLED: boolean = true;

  @IsInt()
  @Min(1)
  @Max(90)
  REFRESH_TOKEN_TTL_DAYS: number = 7;

  @Transform(toBoolean)
  @IsBoolean()
  COOKIE_SECURE: boolean = false;

  @IsEnum(CookieSameSite)
  COOKIE_SAMESITE: CookieSameSite = CookieSameSite.Strict;

  /** Browsers drop the cookie unless this matches the API host; leave unset for host-only. */
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsFQDN(
    {},
    {
      message:
        'COOKIE_DOMAIN must be a domain name such as example.com, or empty to scope the cookie to the API host',
    },
  )
  COOKIE_DOMAIN?: string;

  @IsInt()
  @Min(5)
  @Max(1440)
  PASSWORD_RESET_TTL_MINUTES: number = 30;

  @IsInt()
  @Min(1)
  @Max(720)
  INVITATION_TTL_HOURS: number = 72;

  @IsInt()
  @Min(1)
  @Max(720)
  EMAIL_VERIFICATION_TTL_HOURS: number = 24;

  /** How long a checkout quote can be used to place an order. */
  @IsInt()
  @Min(1)
  @Max(1440)
  QUOTE_TTL_MINUTES: number = 30;

  @IsEnum(MailTransportKind)
  MAIL_TRANSPORT: MailTransportKind = MailTransportKind.Console;

  @IsString()
  @IsNotEmpty()
  MAIL_FROM: string = 'Ecom Dash <no-reply@localhost>';

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  SMTP_HOST?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT?: number;

  @Transform(toBoolean)
  @IsBoolean()
  SMTP_SECURE: boolean = false;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  SMTP_PASS?: string;
}

export type Env = EnvironmentVariables;

/** Splits and normalizes a comma-separated origin list; invalid entries are dropped. */
export function parseOrigins(raw: string): string[] {
  const origins: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const { origin, protocol } = new URL(trimmed);
      if (origin !== 'null' && /^https?:$/.test(protocol)) origins.push(origin);
    } catch {
      // Reported by validate() because the normalized list will be shorter.
    }
  }
  return origins;
}

/** Cross-field rules that single-property decorators cannot express. */
function checkCrossFieldRules(config: EnvironmentVariables): string[] {
  const problems: string[] = [];

  if (config.PUBLIC_API_URL) {
    const url = new URL(config.PUBLIC_API_URL);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      problems.push(
        'PUBLIC_API_URL must be an http(s) origin without credentials, path, query or fragment',
      );
    }
  }

  const entries = config.CORS_ORIGINS.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    entries.length === 0 ||
    parseOrigins(config.CORS_ORIGINS).length !== entries.length
  ) {
    problems.push(
      'CORS_ORIGINS must be a comma-separated list of http(s) origins such as http://localhost:3000',
    );
  }

  if (config.COOKIE_SAMESITE === CookieSameSite.None && !config.COOKIE_SECURE) {
    problems.push('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
  }

  if (config.MAIL_TRANSPORT === MailTransportKind.Smtp) {
    if (!config.SMTP_HOST)
      problems.push('SMTP_HOST is required when MAIL_TRANSPORT=smtp');
    if (!config.SMTP_PORT)
      problems.push('SMTP_PORT is required when MAIL_TRANSPORT=smtp');
    if (!!config.SMTP_USER !== !!config.SMTP_PASS) {
      problems.push('SMTP_USER and SMTP_PASS must be set together');
    }
  }

  if (config.NODE_ENV === NodeEnv.Production) {
    if (!config.PUBLIC_API_URL?.startsWith('https://')) {
      problems.push('PUBLIC_API_URL must use https in production');
    }
    if (!config.COOKIE_SECURE) {
      problems.push('COOKIE_SECURE must be true in production');
    }
    if (!config.RATE_LIMIT_ENABLED) {
      problems.push('RATE_LIMIT_ENABLED must be true in production');
    }
    if (config.MAIL_TRANSPORT !== MailTransportKind.Smtp) {
      problems.push('MAIL_TRANSPORT must be smtp in production');
    }
    if (!config.FRONTEND_URL.startsWith('https://')) {
      problems.push('FRONTEND_URL must use https in production');
    }
  }

  return problems;
}

/** Used as `ConfigModule.forRoot({ validate })`; throws one error listing every problem. */
export function validate(raw: Record<string, unknown>): EnvironmentVariables {
  const config = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  const problems = validateSync(config, {
    skipMissingProperties: false,
  }).flatMap((error) => Object.values(error.constraints ?? {}));

  // Cross-field checks read values that may be missing, so run them only on a valid base.
  if (problems.length === 0) problems.push(...checkCrossFieldRules(config));

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  return config;
}
