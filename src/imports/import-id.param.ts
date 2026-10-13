import { PublicNumberParam } from '../common/public-id.param';

export const ImportNumberParam = () =>
  PublicNumberParam({ prefix: 'IMP', param: 'jobId' });
