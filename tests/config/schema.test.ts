import { describe, expect, it } from 'vitest';
import { localCiConfigSchema } from '../../src/config/schema.js';

describe('localCiConfigSchema', () => {
  it('accepts the MVP configuration', () => {
    const result = localCiConfigSchema.safeParse({
      version: 1,
      project: { type: 'angular' },
      pipeline: ['install', 'test', 'build'],
      settings: { failFast: false },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unsupported config versions', () => {
    const result = localCiConfigSchema.safeParse({
      version: 2,
      project: { type: 'angular' },
      pipeline: ['test'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional pipeline timeout', () => {
    const result = localCiConfigSchema.safeParse({
      version: 1,
      project: { type: 'angular' },
      pipeline: ['test'],
      settings: { failFast: false, timeoutMs: 300_000 },
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.timeoutMs).toBe(300_000);
  });

  it('leaves the timeout undefined when it is not configured', () => {
    const result = localCiConfigSchema.safeParse({
      version: 1,
      project: { type: 'angular' },
      pipeline: ['test'],
      settings: { failFast: false },
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.timeoutMs).toBeUndefined();
  });

  it('rejects a non-positive or non-integer timeout', () => {
    for (const timeoutMs of [0, -1, 1.5]) {
      const result = localCiConfigSchema.safeParse({
        version: 1,
        project: { type: 'angular' },
        pipeline: ['test'],
        settings: { failFast: false, timeoutMs },
      });
      expect(result.success).toBe(false);
    }
  });
});
