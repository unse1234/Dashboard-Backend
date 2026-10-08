import { Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

@Injectable()
export class PasswordService implements OnModuleInit {
  // Verified against when the account (or its password) does not exist, so a
  // failed login costs the same time whether or not the email is registered.
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(randomBytes(16).toString('hex'));
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  /** `hash` may be null (unknown user / invited user without a password yet). */
  async verify(hash: string | null, password: string): Promise<boolean> {
    try {
      const matches = await argon2.verify(hash ?? this.dummyHash, password);
      return hash !== null && matches;
    } catch {
      return false;
    }
  }
}
