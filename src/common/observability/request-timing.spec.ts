import express from 'express';
import request from 'supertest';
import {
  measureOperation,
  recordDatabaseQuery,
  requestTimingMiddleware,
} from './request-timing';

describe('request timing middleware', () => {
  it('attributes interleaved work to each request and redacts route values', async () => {
    const summaries: string[] = [];
    const app = express();
    app.use(
      requestTimingMiddleware({
        enabled: true,
        slowRequestMs: 0,
        allowedOrigins: new Set(['https://dashboard.example']),
        log: (summary) => summaries.push(summary),
      }),
    );
    let firstReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      firstReached = resolve;
    });
    let releaseFirst!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    app.get('/probe/:id', async (req, res) => {
      if (req.params.id === 'first-secret') {
        recordDatabaseQuery(2);
        firstReached();
        await measureOperation('session_lookup', () => released);
        recordDatabaseQuery(3);
      } else {
        await measureOperation('session_lookup', () => {
          recordDatabaseQuery(7);
          return Promise.resolve();
        });
      }
      res.json({ ok: true });
    });
    const first = request(app)
      .get('/probe/first-secret?token=reset-secret')
      .set('Cookie', 'refresh_token=cookie-secret')
      .set('Origin', 'https://dashboard.example')
      .then((response) => response);
    await reached;
    const second = await request(app).get('/probe/second-secret');
    releaseFirst();
    const firstResponse = await first;

    expect(firstResponse.headers['server-timing']).toContain('db;dur=5');
    expect(firstResponse.headers['server-timing']).toContain(
      'db_count;desc="2"',
    );
    expect(second.headers['server-timing']).toContain('db;dur=7');
    expect(second.headers['server-timing']).toContain('db_count;desc="1"');
    expect(firstResponse.headers['server-timing']).toContain(
      'session_lookup;dur=',
    );
    expect(firstResponse.headers['timing-allow-origin']).toBe(
      'https://dashboard.example',
    );
    expect(second.headers).not.toHaveProperty('timing-allow-origin');
    expect(firstResponse.headers['x-request-id']).not.toBe(
      second.headers['x-request-id'],
    );
    expect(summaries).toHaveLength(2); // finish followed by close is logged once.
    const logs = summaries.map(
      (summary) =>
        JSON.parse(summary) as {
          route: string;
          dbQueries: number;
          dbMs: number;
          requestId: string;
        },
    );
    expect(logs.every((log) => log.route === '/probe/:id')).toBe(true);
    expect(logs.find((log) => log.dbQueries === 2)?.dbMs).toBe(5);
    expect(summaries.join()).not.toMatch(
      /first-secret|second-secret|reset-secret|cookie-secret/,
    );
  });

  it('logs server failures even below the slow threshold', async () => {
    const summaries: string[] = [];
    const app = express();
    app.use(
      requestTimingMiddleware({
        enabled: true,
        slowRequestMs: 120_000,
        allowedOrigins: new Set(),
        log: (summary) => summaries.push(summary),
      }),
    );
    app.get('/unavailable', async (_req, res) => {
      await expect(
        measureOperation('session_lookup', () =>
          Promise.reject(new Error('temporary failure')),
        ),
      ).rejects.toThrow('temporary failure');
      res.status(503).json({ message: 'Unavailable' });
    });
    const response = await request(app).get('/unavailable');
    expect(response.status).toBe(503);
    expect(response.headers['server-timing']).toContain('session_lookup;dur=');
    expect(JSON.parse(summaries[0]) as { status: number }).toMatchObject({
      status: 503,
    });
  });

  it('can disable instrumentation without altering the response', async () => {
    const log = jest.fn();
    const app = express();
    app.use(
      requestTimingMiddleware({
        enabled: false,
        slowRequestMs: 0,
        allowedOrigins: new Set(),
        log,
      }),
    );
    app.get('/probe', (_req, res) => res.json({ ok: true }));
    const response = await request(app).get('/probe');
    expect(response.body).toEqual({ ok: true });
    expect(response.headers).not.toHaveProperty('server-timing');
    expect(response.headers).not.toHaveProperty('x-request-id');
    expect(log).not.toHaveBeenCalled();
  });
});
