import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAngularStep,
  createAngularSteps,
  describeMissingAngular,
  registerAngularSteps,
} from '../../../src/adapters/angular/steps.js';
import { detectAngularProject } from '../../../src/adapters/angular/detect.js';
import { PipelineRunner } from '../../../src/core/pipeline-runner.js';
import { StepRegistry } from '../../../src/core/step-runner.js';
import type { ProcessExecutor, ProcessResult, RunProcessOptions } from '../../../src/core/process-runner.js';
import type { PipelineContext } from '../../../src/core/context.js';

interface Invocation {
  command: string;
  args: readonly string[];
  cwd: string;
  envKeys: string[];
}

function fakeExecutor(
  outcome: Partial<ProcessResult> = {},
  log: Invocation[] = [],
): ProcessExecutor {
  return async (command, args, options: RunProcessOptions): Promise<ProcessResult> => {
    log.push({
      command,
      args,
      cwd: options.cwd,
      envKeys: Object.keys(options.env ?? {}),
    });

    return {
      command,
      args: [...args],
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 5,
      timedOut: false,
      cancelled: false,
      failed: false,
      ...outcome,
    };
  };
}

async function detectionFor(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'local-ci-steps-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  return detectAngularProject(dir);
}

function contextFor(cwd: string, pipeline: string[]): PipelineContext {
  return {
    cwd,
    runId: 'angular-adapter-test',
    config: {
      version: 1,
      project: { type: 'angular' },
      pipeline,
      settings: { failFast: false },
    },
  };
}

const FULL_PROJECT = {
  'package.json': JSON.stringify({
    name: 'app',
    scripts: { typecheck: 'tsc --noEmit', test: 'ng test', coverage: 'ng test --code-coverage', lint: 'ng lint', build: 'ng build' },
    dependencies: { '@angular/core': '^19.0.0' },
    devDependencies: { '@angular/cli': '^19.0.0' },
  }),
  'angular.json': JSON.stringify({ version: 1 }),
  'package-lock.json': '{}',
};

describe('createAngularStep', () => {
  it('builds a runnable step for a resolved command', async () => {
    const detection = await detectionFor(FULL_PROJECT);
    const log: Invocation[] = [];
    const step = createAngularStep('test', { status: 'resolved', command: 'npm', args: ['run', 'test'], description: 'npm run test' }, { exec: fakeExecutor({}, log) });

    const result = await step.run(contextFor(process.cwd(), ['test']));

    expect(result.status).toBe('PASS');
    expect(result.name).toBe('Unit Tests');
    expect(log[0]?.command).toBe('npm');
    expect(log[0]?.args).toEqual(['run', 'test']);
  });

  it('builds an UNSUPPORTED step that explains itself', async () => {
    const step = createAngularStep('lint', {
      status: 'unsupported',
      reason: 'No "lint" script in package.json.',
    });

    const result = await step.run(contextFor(process.cwd(), ['lint']));

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.error).toBe('No "lint" script in package.json.');
    expect(result.durationMs).toBe(0);
  });

  it('propagates a real failure as FAIL, never as PASS', async () => {
    const detection = await detectionFor(FULL_PROJECT);
    const step = createAngularStep('build', { status: 'resolved', command: 'npm', args: ['run', 'build'], description: 'npm run build' }, {
      exec: fakeExecutor({ failed: true, exitCode: 1, stderr: 'compilation failed' }),
    });

    const result = await step.run(contextFor(process.cwd(), ['build']));

    expect(result.status).toBe('FAIL');
    expect(result.exitCode).toBe(1);
  });
});

describe('createAngularSteps', () => {
  it('resolves every Angular step id for a complete project', async () => {
    const steps = createAngularSteps(await detectionFor(FULL_PROJECT));

    expect([...steps.keys()].sort()).toEqual(
      ['build', 'coverage', 'install', 'lint', 'security', 'test', 'typecheck'],
    );
    for (const step of steps.values()) {
      expect(step.name).not.toBe(step.id === 'install' ? 'install' : '');
    }
  });

  it('gives steps human-readable report names', async () => {
    const steps = createAngularSteps(await detectionFor(FULL_PROJECT));

    expect(steps.get('install')?.name).toBe('Dependencies');
    expect(steps.get('test')?.name).toBe('Unit Tests');
    expect(steps.get('build')?.name).toBe('Production Build');
  });
});

describe('registerAngularSteps', () => {
  it('registers only the steps the pipeline asks for', async () => {
    const detection = await detectionFor(FULL_PROJECT);
    const registry = new StepRegistry();
    registerAngularSteps(registry, detection, ['install', 'test']);

    expect(registry.has('install')).toBe(true);
    expect(registry.has('test')).toBe(true);
    expect(registry.has('build')).toBe(false);
  });

  it('leaves non-Angular ids unregistered so the core reports UNSUPPORTED', async () => {
    const registry = new StepRegistry();
    registerAngularSteps(registry, await detectionFor(FULL_PROJECT), ['deploy']);

    expect(registry.has('deploy')).toBe(false);
  });

  it('drives the real PipelineRunner end to end without spawning anything', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'local-ci-e2e-'));
    for (const [name, content] of Object.entries(FULL_PROJECT)) {
      await writeFile(join(cwd, name), content, 'utf8');
    }

    const detection = await detectAngularProject(cwd);
    const registry = new StepRegistry();
    const log: Invocation[] = [];
    registerAngularSteps(registry, detection, ['install', 'typecheck', 'test', 'coverage', 'lint', 'build', 'security'], {
      exec: fakeExecutor({}, log),
    });

    const result = await new PipelineRunner(registry).run(
      contextFor(cwd, ['install', 'typecheck', 'test', 'coverage', 'lint', 'build', 'security']),
    );

    expect(result.status).toBe('PASS');
    expect(result.steps.map((step) => step.status)).toEqual(Array(7).fill('PASS'));
    expect(log.map((entry) => `${entry.command} ${entry.args.join(' ')}`)).toEqual([
      'npm ci',
      'npm run typecheck',
      'npm run test',
      'npm run coverage',
      'npm run lint',
      'npm run build',
      'npm audit --json',
    ]);
    // Every command ran in the project directory.
    expect(log.every((entry) => entry.cwd === cwd)).toBe(true);
  });

  it('reports a project without scripts honestly instead of faking passes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'local-ci-bare-'));
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^19.0.0' } }), 'utf8');
    await writeFile(join(cwd, 'angular.json'), '{}', 'utf8');

    const detection = await detectAngularProject(cwd);
    const registry = new StepRegistry();
    registerAngularSteps(registry, detection, ['test', 'lint', 'typecheck']);

    const result = await new PipelineRunner(registry).run(contextFor(cwd, ['test', 'lint', 'typecheck']));

    expect(result.status).toBe('FAIL');
    expect(result.steps.every((step) => step.status === 'UNSUPPORTED')).toBe(true);
  });

  it('passes no environment variables to child processes', async () => {
    const detection = await detectionFor(FULL_PROJECT);
    const registry = new StepRegistry();
    const log: Invocation[] = [];
    registerAngularSteps(registry, detection, ['build'], { exec: fakeExecutor({}, log) });

    await new PipelineRunner(registry).run(contextFor(process.cwd(), ['build']));

    expect(log[0]?.envKeys).toEqual([]);
  });
});

describe('describeMissingAngular', () => {
  it('explains why Angular was not detected', async () => {
    const detection = await detectionFor({ 'package.json': JSON.stringify({ name: 'plain' }) });

    expect(describeMissingAngular(detection)).toContain('Angular was not detected');
  });

  it('falls back to a generic message when no reason was recorded', () => {
    expect(
      describeMissingAngular({
        detected: false,
        framework: null,
        angularConfig: null,
        packageJson: null,
        packageManager: null,
        lockfile: null,
        packageManagerIsDefault: true,
        scripts: {},
        dependencies: {},
        devDependencies: {},
      }),
    ).toContain('project.type: angular');
  });
});