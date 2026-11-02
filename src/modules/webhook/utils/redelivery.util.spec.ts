import { clampMaxAgeMinutes, isReceiverRejection, redeliveryDecision } from './redelivery.util';

describe('redelivery.util', () => {
  const now = Date.parse('2026-11-02T08:00:00Z');

  it('retries this session’s recent connection failures', () => {
    const job = { sessionId: 's1', timestamp: now - 60 * 60_000, failedReason: 'fetch failed' };
    expect(redeliveryDecision(job, 's1', now, 1440)).toBe('retry');
    expect(redeliveryDecision({ ...job, failedReason: 'HTTP 502: Bad Gateway' }, 's1', now, 1440)).toBe('retry');
    expect(
      redeliveryDecision({ ...job, failedReason: 'The operation was aborted due to timeout' }, 's1', now, 1440),
    ).toBe('retry');
  });

  it('skips other sessions, old jobs and payloads the receiver refused', () => {
    const job = { sessionId: 's1', timestamp: now - 60 * 60_000, failedReason: 'fetch failed' };
    expect(redeliveryDecision({ ...job, sessionId: 's2' }, 's1', now, 1440)).toBe('other_session');
    expect(redeliveryDecision({ ...job, timestamp: now - 25 * 60 * 60_000 }, 's1', now, 1440)).toBe('too_old');
    expect(redeliveryDecision({ ...job, failedReason: 'HTTP 401: Unauthorized' }, 's1', now, 1440)).toBe(
      'rejected_by_receiver',
    );
    expect(isReceiverRejection('HTTP 503: Service Unavailable')).toBe(false);
  });

  it('clamps the age window', () => {
    expect(clampMaxAgeMinutes(undefined)).toBe(1440);
    expect(clampMaxAgeMinutes(Number.NaN)).toBe(1440);
    expect(clampMaxAgeMinutes(0)).toBe(1440);
    expect(clampMaxAgeMinutes(90)).toBe(90);
    expect(clampMaxAgeMinutes(99999)).toBe(10080);
  });
});
