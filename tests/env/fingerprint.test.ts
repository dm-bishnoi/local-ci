/**
 * The environment fingerprint.
 *
 * Two properties are non-negotiable and are tested from both directions:
 * the fingerprint captures the facts a report needs to be self-describing, and
 * it has no field that could carry a secret.
 */

import { describe, expect, it } from 'vitest';
import {
  buildFingerprint,
  currentRuntime,
  detectCiIndicator,
  declaredAngularVersion,
  FINGERPRINT_KEYS,
  FINGERPRINT_SCHEMA_VERSION,
  readInstalledPackageVersion,
} from '../../src/env/fingerprint.js';
import type { AngularDetection } from '../../src/adapters/angular/detect.js';
import { withTempProject } from '../helpers/reports.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DETECTION: AngularDetection = {
  detected: true,
  framework: 'angular',
  angularConfig: '/p/angular.json',
  packageJson: '/p/package.json',
  packageManager: 'npm',
  lockfile: 'package-lock.json',
  packageManagerIsDefault: false,
  scripts: { build: 'ng build' },
  dependencies: { '@angular/core': '^19.0.0' },
  devDependencies: {},
};

function baseInput(cwd: string) {
  return {
    cwd,
    projectName: 'app',
    projectType: 'angular',
    detection: DETECTION,
    packageManagerVersion: '10.9.2',
    gitVersion: '2.47.1',
    browsers: [{ name: 'chrome' as const, version: '131.0.0.0' }],
    capturedAt: new Date('2026-10-08T00:00:00.000Z'),
  };
}

describe('buildFingerprint', () => {
  it('captures the documented facts', async () => {
    const fingerprint = await buildFingerprint({ ...baseInput('/p'), installedAngularVersion: null });

    expect(fingerprint.schemaVersion).toBe(FINGERPRINT_SCHEMA_VERSION);
    expect(fingerprint.capturedAt).toBe('2026-10-08T00:00:00.000Z');
    expect(fingerprint.os.platform).toBe(process.platform);
    expect(fingerprint.os.arch).toBe(process.arch);
    expect(fingerprint.runtime).toEqual({ name: 'node', version: process.versions.node, source: 'probed' });
    expect(fingerprint.packageManager).toEqual({ name: 'npm', version: '10.9.2' });
    expect(fingerprint.git).toEqual({ name: 'git', version: '2.47.1', source: 'probed' });
    expect(fingerprint.project).toEqual({ name: 'app', type: 'angular', framework: 'angular' });
    expect(fingerprint.angular).toEqual({ declared: '^19.0.0', installed: null });
    expect(fingerprint.browsers).toEqual([{ name: 'chrome', version: '131.0.0.0' }]);
    expect(typeof fingerprint.runningInCi).toBe('boolean');
  });

  it('normalizes to exactly the allowed key set — no field can carry a secret', async () => {
    const fingerprint = await buildFingerprint({ ...baseInput('/p'), installedAngularVersion: null });

    expect(Object.keys(fingerprint).sort()).toEqual([...FINGERPRINT_KEYS].sort());
  });

  it('contains no environment variable values even when secrets are set', async () => {
    process.env['LOCAL_CI_FINGERPRINT_TEST_SECRET'] = 'super-secret-value';
    try {
      const fingerprint = await buildFingerprint({ ...baseInput('/p'), installedAngularVersion: null });
      const serialized = JSON.stringify(fingerprint);
      expect(serialized).not.toContain('super-secret-value');
      expect(serialized).not.toContain('LOCAL_CI_FINGERPRINT_TEST_SECRET');
    } finally {
      delete process.env['LOCAL_CI_FINGERPRINT_TEST_SECRET'];
    }
  });

  it('reads the installed Angular version from node_modules when not supplied', async () => {
    await withTempProject(async (cwd) => {
      const pkgDir = join(cwd, 'node_modules', '@angular', 'core');
      await mkdir(pkgDir, { recursive: true });
      await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ version: '19.2.1' }), 'utf8');

      const fingerprint = await buildFingerprint(baseInput(cwd));
      expect(fingerprint.angular?.installed).toBe('19.2.1');
    });
  });

  it('returns null rather than guessing when the installed version is unreadable', async () => {
    await withTempProject(async (cwd) => {
      expect(await readInstalledPackageVersion(cwd, '@angular/core')).toBeNull();
    });
  });

  it('has no angular block for a non-Angular project', async () => {
    const fingerprint = await buildFingerprint({
      ...baseInput('/p'),
      detection: { ...DETECTION, framework: null, detected: false, dependencies: {} },
      installedAngularVersion: null,
    });
    expect(fingerprint.angular).toBeNull();
  });
});

describe('detectCiIndicator', () => {
  it('detects well-known CI markers by presence only', () => {
    expect(detectCiIndicator({ CI: 'true' })).toBe(true);
    expect(detectCiIndicator({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(detectCiIndicator({ BUILD_NUMBER: '5' })).toBe(true);
    expect(detectCiIndicator({})).toBe(false);
  });

  it('never stores the marker value', () => {
    const fingerprintEnv = { CI: 'some-ci-provider-token-like-value' };
    expect(detectCiIndicator(fingerprintEnv)).toBe(true);
    // The boolean is the whole contract; the value must not travel further.
    expect(String(detectCiIndicator(fingerprintEnv))).toBe('true');
  });
});

describe('declaredAngularVersion', () => {
  it('reads the declared range from dependencies or devDependencies', () => {
    expect(declaredAngularVersion(DETECTION)).toBe('^19.0.0');
    expect(declaredAngularVersion({ ...DETECTION, dependencies: {}, devDependencies: { '@angular/core': '^18.0.0' } })).toBe('^18.0.0');
    expect(declaredAngularVersion(null)).toBeNull();
  });
});

describe('currentRuntime', () => {
  it('reports the running Node version as probed', () => {
    expect(currentRuntime()).toEqual({ name: 'node', version: process.versions.node, source: 'probed' });
  });
});
