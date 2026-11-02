/**
 * Redelivery of webhook jobs that failed while the receiver was unreachable
 * (e.g. the Sophia app on a laptop that was asleep). BullMQ keeps failed jobs,
 * with the original payload and signature, so they can be retried as they were.
 */

export const REDELIVER_DEFAULT_MAX_AGE_MINUTES = 24 * 60;
export const REDELIVER_MAX_AGE_MINUTES_LIMIT = 7 * 24 * 60;

export interface RedeliveryCandidate {
  readonly sessionId: string | undefined;
  /** When the job was created (ms). */
  readonly timestamp: number;
  readonly failedReason: string | undefined;
}

export type RedeliveryDecision = 'retry' | 'other_session' | 'too_old' | 'rejected_by_receiver';

/**
 * A 4xx means the receiver answered and refused the payload: sending it again
 * gives the same answer. Connection errors, timeouts and 5xx are worth a retry.
 */
export function isReceiverRejection(failedReason: string | undefined): boolean {
  return /^HTTP 4\d\d\b/.test(failedReason ?? '');
}

export function redeliveryDecision(
  job: RedeliveryCandidate,
  sessionId: string,
  nowMs: number,
  maxAgeMinutes: number,
): RedeliveryDecision {
  if (job.sessionId !== sessionId) return 'other_session';
  if (job.timestamp < nowMs - maxAgeMinutes * 60_000) return 'too_old';
  if (isReceiverRejection(job.failedReason)) return 'rejected_by_receiver';
  return 'retry';
}

export function clampMaxAgeMinutes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return REDELIVER_DEFAULT_MAX_AGE_MINUTES;
  return Math.min(Math.floor(value), REDELIVER_MAX_AGE_MINUTES_LIMIT);
}
