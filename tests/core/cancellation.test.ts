import { afterEach, describe, expect, it } from 'vitest';
import { activeCancellations, createRunCancellation } from '../../src/core/cancellation.js';

const created: Array<{ dispose(): void }> = [];

function makeCancellation() {
  const cancellation = createRunCancellation();
  created.push(cancellation);
  return cancellation;
}

afterEach(() => {
  while (created.length > 0) created.pop()?.dispose();
});

describe('createRunCancellation', () => {
  it('starts uncancelled with a live signal', () => {
    const cancellation = makeCancellation();

    expect(cancellation.cancelled).toBe(false);
    expect(cancellation.signal.aborted).toBe(false);
  });

  it('aborts the signal when cancelled', () => {
    const cancellation = makeCancellation();
    cancellation.cancel('test');

    expect(cancellation.cancelled).toBe(true);
    expect(cancellation.signal.aborted).toBe(true);
  });

  it('is idempotent: repeated cancel does not re-fire', () => {
    const reasons: string[] = [];
    const cancellation = createRunCancellation((reason) => reasons.push(reason));
    created.push(cancellation);

    cancellation.cancel('first');
    cancellation.cancel('second');

    expect(reasons).toEqual(['first']);
  });

  it('reports why it was cancelled', () => {
    const reasons: string[] = [];
    const cancellation = createRunCancellation((reason) => reasons.push(reason));
    created.push(cancellation);

    cancellation.cancel('because tests');
    expect(reasons).toContain('because tests');
  });

  it('does not leak process signal listeners after dispose', () => {
    const before = process.listenerCount('SIGINT');

    const first = createRunCancellation();
    const second = createRunCancellation();
    expect(process.listenerCount('SIGINT')).toBe(before + 2);

    first.dispose();
    second.dispose();

    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('tolerates dispose being called twice', () => {
    const cancellation = createRunCancellation();
    cancellation.dispose();
    expect(() => cancellation.dispose()).not.toThrow();
  });

  it('tracks how many cancellations are active', () => {
    const baseline = activeCancellations();
    const first = createRunCancellation();
    const second = createRunCancellation();

    expect(activeCancellations()).toBe(baseline + 2);

    first.dispose();
    second.dispose();

    expect(activeCancellations()).toBe(baseline);
  });

  it('does not abort when disposed without cancelling', () => {
    const cancellation = makeCancellation();
    cancellation.dispose();

    expect(cancellation.signal.aborted).toBe(false);
    expect(cancellation.active).toBe(false);
  });
});