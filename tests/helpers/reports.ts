import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineRunResult, PipelineStatus } from '../../src/core/pipeline-runner.js';
import type { StepResult, StepStatus } from '../../src/core/step-runner.js';
import { buildRunReport, type BuiltReport, type RunMetadata } from '../../src/reporters/report-model.js';

/** Report names the Angular adapter uses, so tests read like a real report. */
const STEP_NAMES: Record<string, string> = {
  install: 'Dependencies',
  typecheck: 'TypeScript',
  test: 'Unit Tests',
  coverage: 'Coverage',
  lint: 'Lint',
  build: 'Production Build',
  security: 'Security',
};

export const TEST_METADATA: RunMetadata = {
  projectName: 'my-angular-app',
  projectType: 'angular',
  framework: 'angular',
  packageManager: 'npm',
};

export function makeStep(id: string, status: StepStatus, overrides: Partial<StepResult> = {}): StepResult {
  return {
    id,
    name: STEP_NAMES[id] ?? id,
    status,
    durationMs: 1_000,
    startedAt: '2026-10-08T12:34:56.000Z',
    endedAt: '2026-10-08T12:34:57.000Z',
    ...overrides,
  };
}

export function makeRunResult(
  steps: StepResult[],
  overrides: Partial<PipelineRunResult> = {},
): PipelineRunResult {
  const hasFailure = steps.some(
    (step) =>
      step.status === 'FAIL' ||
      step.status === 'UNSUPPORTED' ||
      step.status === 'CANCELLED' ||
      step.status === 'BLOCKED' ||
      step.status === 'ERROR',
  );
  const status: PipelineStatus =
    overrides.status ?? (steps.some((step) => step.status === 'CANCELLED') ? 'CANCELLED' : hasFailure ? 'FAIL' : 'PASS');

  return {
    runId: '20261008-123456-abcd1234',
    status,
    durationMs: 76_000,
    startedAt: '2026-10-08T12:34:56.000Z',
    endedAt: '2026-10-08T12:36:12.000Z',
    cancelled: status === 'CANCELLED',
    steps,
    ...overrides,
  };
}

export function makeBuilt(
  steps: StepResult[],
  options: Partial<Parameters<typeof buildRunReport>[0]> = {},
): BuiltReport {
  return buildRunReport({
    result: makeRunResult(steps),
    metadata: TEST_METADATA,
    now: () => new Date('2026-10-08T12:36:13.000Z'),
    ...options,
  });
}

/** Runs `body` with an environment variable set, restoring it afterwards. */
export async function withEnv<T>(name: string, value: string, body: () => Promise<T> | T): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/** Creates an isolated project directory and removes it afterwards. */
export async function withTempProject<T>(body: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'local-ci-test-'));
  try {
    return await body(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}