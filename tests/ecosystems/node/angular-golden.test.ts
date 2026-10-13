import { afterEach, describe, expect, it } from 'vitest';
import { resolveStep, supportedStepIds } from '../../../src/adapters/angular/commands.js';
import { detectAngularProject } from '../../../src/adapters/angular/detect.js';
import { detectNode, resolveNodeStep } from '../../../src/ecosystems/node/index.js';
import { cleanupTrees, makeTree } from '../../helpers/tree.js';

afterEach(cleanupTrees);

/**
 * The Node adapter replaces the Angular-only resolvers. For every Angular
 * project shape the two must agree exactly, so existing Angular configs keep
 * resolving to byte-identical commands.
 */
interface Shape {
  name: string;
  files: Record<string, string | object>;
}

const angularJson = { version: 1, projects: {} };

function pkg(extra: Record<string, unknown>): Record<string, unknown> {
  return { name: 'app', ...extra };
}

const SHAPES: Shape[] = [
  { name: 'bare angular.json, no package scripts', files: { 'angular.json': angularJson, 'package.json': pkg({}) } },
  {
    name: 'full scripts, npm lockfile',
    files: {
      'angular.json': angularJson,
      'package-lock.json': '{}',
      'package.json': pkg({
        scripts: { build: 'ng build', test: 'ng test', lint: 'ng lint', typecheck: 'tsc --noEmit', coverage: 'ng test --cc' },
        dependencies: { '@angular/core': '^19.0.0' },
      }),
    },
  },
  {
    name: 'pnpm, cli only (build falls back to ng)',
    files: {
      'angular.json': angularJson,
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'package.json': pkg({ devDependencies: { '@angular/cli': '^19.0.0' } }),
    },
  },
  {
    name: 'yarn classic, test script + coverage provider',
    files: {
      'angular.json': angularJson,
      'yarn.lock': '# yarn',
      'package.json': pkg({
        scripts: { test: 'ng test' },
        devDependencies: { 'karma-coverage': '^2.0.0', '@angular/cli': '^19.0.0', typescript: '^5.0.0' },
      }),
      'tsconfig.json': '{}',
    },
  },
  {
    name: 'npm without lockfile, jest + eslint declared (must not be inferred for Angular)',
    files: {
      'package.json': pkg({
        scripts: { test: 'jest' },
        dependencies: { '@angular/core': '^19.0.0' },
        devDependencies: { jest: '^29.0.0', eslint: '^9.0.0', typescript: '^5.0.0' },
      }),
      'eslint.config.js': 'export default [];',
      'tsconfig.json': '{}',
    },
  },
  {
    name: 'empty-string scripts are not scripts',
    files: { 'angular.json': angularJson, 'package.json': pkg({ scripts: { build: '  ', test: '' } }) },
  },
];

describe('Node adapter resolves Angular projects exactly like the Angular adapter', () => {
  for (const shape of SHAPES) {
    it(shape.name, async () => {
      const dir = await makeTree(shape.files);
      const old = await detectAngularProject(dir);
      const node = await detectNode(dir);
      expect(node.frameworks).toContain('angular');

      for (const id of supportedStepIds()) {
        const expected = resolveStep(id, old)!;
        const actual = resolveNodeStep(id, node)!;
        if (expected.status === 'unsupported') {
          expect(actual, id).toEqual({ state: 'unavailable', reason: expected.reason });
        } else {
          expect(actual.state, id).toBe('available');
          if (actual.state === 'available') {
            expect({ command: actual.command, args: actual.args, description: actual.description }, id).toEqual({
              command: expected.command,
              args: expected.args,
              description: expected.description,
            });
          }
        }
      }
    });
  }
});
