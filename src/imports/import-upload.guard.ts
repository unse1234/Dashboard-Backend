import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';

/** Memory storage keeps up to 10 MiB per request; bound in-flight uploads. */
@Injectable()
export class ImportUploadGuard implements CanActivate {
  private active = 0;

  canActivate(context: ExecutionContext): boolean {
    if (this.active >= 2)
      throw new HttpException(
        'Too many uploads in progress.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    this.active++;
    const response = context.switchToHttp().getResponse<Response>();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active--;
    };
    response.once('finish', release);
    response.once('close', release);
    return true;
  }
}
