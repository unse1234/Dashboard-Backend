import { SetMetadata } from '@nestjs/common';

export const ALLOW_UNVERIFIED_KEY = 'allowUnverified';

/** Lets users whose email is not yet verified reach the route. */
export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED_KEY, true);
