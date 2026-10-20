import {
  classifySendFailure,
  EMAIL_JOB_LEASE_MS,
  EMAIL_RETRY_DELAYS_MS,
  retryDelayMs,
} from './email-outbox.policy';

describe('email outbox policy', () => {
  it('backs off 1, 5, 15 then 30 minutes, and stays at the last step', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([
      60_000, 300_000, 900_000, 1_800_000, 1_800_000, 1_800_000,
    ]);
    expect(retryDelayMs(0)).toBe(EMAIL_RETRY_DELAYS_MS[0]);
  });

  it('holds a claim for longer than one send can take', () => {
    // The SMTP transport's longest timeout is 60 s.
    expect(EMAIL_JOB_LEASE_MS).toBeGreaterThan(2 * 60_000);
  });

  it('gives up on a permanent SMTP refusal', () => {
    expect(
      classifySendFailure(
        Object.assign(new Error('550 5.1.1 mailbox unavailable'), {
          responseCode: 550,
        }),
      ),
    ).toEqual({
      retryable: false,
      code: 'SMTP_550',
      message: '550 5.1.1 mailbox unavailable',
    });
  });

  it('retries a temporary refusal, a network error or anything unknown', () => {
    expect(
      classifySendFailure(
        Object.assign(new Error('try later'), { responseCode: 421 }),
      ),
    ).toMatchObject({ retryable: true, code: 'SMTP_421' });
    expect(
      classifySendFailure(
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      ),
    ).toMatchObject({ retryable: true, code: 'ETIMEDOUT' });
    expect(classifySendFailure(new Error('weird'))).toMatchObject({
      retryable: true,
      code: 'SEND_FAILED',
    });
    expect(classifySendFailure('not even an error')).toMatchObject({
      retryable: true,
      code: 'SEND_FAILED',
      message: 'The mail transport failed',
    });
  });

  it('never keeps a token from the error it stores', () => {
    const token = `oc_${'z'.repeat(43)}`;
    const { message } = classifySendFailure(
      Object.assign(
        new Error(`552 message refused: ${token} #token=${token}`),
        {
          responseCode: 552,
        },
      ),
    );
    expect(message).not.toContain('zzzz');
    expect(message).toContain('[redacted]');
  });
});
