import { performance } from 'node:perf_hooks';
import { Pool, type PoolClient } from 'pg';
import { requestTimings } from '../common/observability/request-timing';

type ConnectCallback = Parameters<Pool['connect']>[0];

/** Acquisition includes pool queueing and new TCP/TLS/database connections. */
export class TimedPool extends Pool {
  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    const timing = requestTimings.getStore();
    if (!timing) {
      if (callback) return super.connect(callback);
      return super.connect();
    }
    const started = performance.now();
    const recordWaiting = () => {
      timing.poolWaitingMax = Math.max(
        timing.poolWaitingMax,
        this.waitingCount,
      );
    };
    const finish = () => {
      timing.dbAcquireMs += performance.now() - started;
    };
    if (callback) {
      super.connect((...args) => {
        finish();
        callback(...args);
      });
      recordWaiting();
      return;
    }
    const connecting = super.connect();
    recordWaiting();
    return connecting.then(
      (client) => {
        finish();
        return client;
      },
      (error: unknown) => {
        finish();
        throw error;
      },
    );
  }
}
