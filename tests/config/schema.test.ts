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
});
