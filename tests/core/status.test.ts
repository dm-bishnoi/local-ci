/**
 * The canonical result model.
 *
 * The invariant under test everywhere here: only PASS is success. Every other
 * outcome — including the ones local-ci invents to be honest about *why*
 * something did not run — must be non-success, non-zero-exit, and visible in
 * counts.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateOutcomes,
  countOutcomes,
  exitCodeForOutcome,
  isNotExecuted,
  isRunOutcome,
  isStepStatus,
  isSuccess,
  outcomeOf,
  RUN_OUTCOMES,
  STEP_STATUSES,
  type RunOutcome,
} from '../../src/core/status.js';

describe('status vocabulary', () => {
  it('contains every status the spec requires', () => {
    for (const status of ['PASS', 'FAIL', 'SKIPPED', 'BLOCKED', 'UNSUPPORTED', 'TIMEOUT', 'CANCELLED', 'ERROR']) {
      expect(RUN_OUTCOMES).toContain(status as RunOutcome);
    }
    // TIMEOUT is the one outcome the engine does not emit as a status.
    expect(STEP_STATUSES).not.toContain('TIMEOUT' as never);
    expect(STEP_STATUSES).toContain('BLOCKED' as never);
    expect(STEP_STATUSES).toContain('ERROR' as never);
  });

  it('guards unknown values', () => {
    expect(isStepStatus('PASS')).toBe(true);
    expect(isStepStatus('pass')).toBe(false);
    expect(isStepStatus('TIMEOUT')).toBe(false);
    expect(isRunOutcome('TIMEOUT')).toBe(true);
    expect(isRunOutcome('MAYBE')).toBe(false);
  });
});

describe('only PASS is success', () => {
  it('never treats a non-PASS outcome as success', () => {
    for (const outcome of RUN_OUTCOMES) {
      expect(isSuccess(outcome)).toBe(outcome === 'PASS');
      expect(exitCodeForOutcome(outcome)).toBe(outcome === 'PASS' ? 0 : 1);
    }
  });

  it('classifies the engine failure mode of a timeout as TIMEOUT', () => {
    expect(outcomeOf({ status: 'FAIL', timedOut: true })).toBe('TIMEOUT');
    expect(outcomeOf({ status: 'FAIL' })).toBe('FAIL');
    expect(outcomeOf({ status: 'BLOCKED' })).toBe('BLOCKED');
    expect(isSuccess(outcomeOf({ status: 'FAIL', timedOut: true }))).toBe(false);
  });

  it('recognizes the outcomes that mean "did not run"', () => {
    expect(isNotExecuted('SKIPPED')).toBe(true);
    expect(isNotExecuted('UNSUPPORTED')).toBe(true);
    expect(isNotExecuted('BLOCKED')).toBe(true);
    expect(isNotExecuted('PASS')).toBe(false);
    expect(isNotExecuted('FAIL')).toBe(false);
    expect(isNotExecuted('TIMEOUT')).toBe(false);
  });
});

describe('aggregateOutcomes', () => {
  it('orders by severity, most serious first', () => {
    expect(aggregateOutcomes(['PASS', 'SKIPPED', 'BLOCKED'])).toBe('BLOCKED');
    expect(aggregateOutcomes(['PASS', 'UNSUPPORTED'])).toBe('UNSUPPORTED');
    expect(aggregateOutcomes(['FAIL', 'BLOCKED'])).toBe('BLOCKED');
    expect(aggregateOutcomes(['BLOCKED', 'ERROR'])).toBe('ERROR');
    expect(aggregateOutcomes(['FAIL', 'TIMEOUT'])).toBe('FAIL');
    expect(aggregateOutcomes(['CANCELLED', 'FAIL'])).toBe('CANCELLED');
    expect(aggregateOutcomes(['PASS', 'PASS'])).toBe('PASS');
  });

  it('reports an empty run as SKIPPED, never PASS', () => {
    expect(aggregateOutcomes([])).toBe('SKIPPED');
    expect(isSuccess(aggregateOutcomes([]))).toBe(false);
  });

  it('never aggregates to PASS unless every outcome is PASS', () => {
    for (const outcome of RUN_OUTCOMES) {
      const aggregated = aggregateOutcomes(outcome === 'PASS' ? ['PASS'] : ['PASS', outcome]);
      expect(aggregated === 'PASS').toBe(outcome === 'PASS');
    }
  });
});

describe('countOutcomes', () => {
  it('has an entry for every outcome so counts never surprise', () => {
    const counts = countOutcomes(['PASS', 'PASS', 'FAIL', 'BLOCKED', 'TIMEOUT']);
    expect(counts).toEqual({
      PASS: 2,
      FAIL: 1,
      SKIPPED: 0,
      BLOCKED: 1,
      UNSUPPORTED: 0,
      TIMEOUT: 1,
      CANCELLED: 0,
      ERROR: 0,
    });

    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(5);
  });
});
