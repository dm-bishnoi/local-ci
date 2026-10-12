/**
 * F-5 regression: a package inside a monorepo resolves its package manager
 * from the workspace root's lockfile, and nothing outside a real workspace or
 * outside the repository can influence that decision.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectPackageManager, findWorkspaceRoot } from '../../../src/adapters/angular/detect.js';
import { withTempProject } from '../../helpers/reports.js';

async function write(path: string, content = ''): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

describe('workspace-root lockfile detection', () => {
  it('uses the npm workspace root lockfile for a member package', async () => {
    await withTempProject(async (root) => {
      await write(join(root, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }));
      await write(join(root, 'package-lock.json'), '{}');
      const app = join(root, 'packages', 'app');
      await write(join(app, 'package.json'), JSON.stringify({ name: 'app' }));

      expect(await findWorkspaceRoot(app)).toBe(root);
      expect(await detectPackageManager(app)).toEqual({
        manager: 'npm',
        lockfile: join('..', '..', 'package-lock.json'),
        isDefault: false,
      });
    });
  });

  it('uses the pnpm workspace root lockfile for a member package', async () => {
    await withTempProject(async (root) => {
      await write(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
      await write(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      const app = join(root, 'apps', 'web');
      await write(join(app, 'package.json'), '{}');

      const detected = await detectPackageManager(app);
      expect(detected.manager).toBe('pnpm');
      expect(detected.lockfile).toBe(join('..', '..', 'pnpm-lock.yaml'));
    });
  });

  it('prefers a lockfile in the project itself', async () => {
    await withTempProject(async (root) => {
      await write(join(root, 'package.json'), JSON.stringify({ workspaces: ['app'] }));
      await write(join(root, 'pnpm-lock.yaml'));
      const app = join(root, 'app');
      await write(join(app, 'yarn.lock'));

      expect(await detectPackageManager(app)).toEqual({ manager: 'yarn', lockfile: 'yarn.lock', isDefault: false });
    });
  });

  it('ignores an ancestor lockfile when the ancestor is not a workspace root', async () => {
    await withTempProject(async (root) => {
      await write(join(root, 'package.json'), JSON.stringify({ name: 'not-a-workspace' }));
      await write(join(root, 'package-lock.json'), '{}');
      const app = join(root, 'app');
      await write(join(app, 'package.json'), '{}');

      expect(await detectPackageManager(app)).toEqual({ manager: 'npm', lockfile: null, isDefault: true });
    });
  });

  it('never looks past the enclosing git repository', async () => {
    await withTempProject(async (outer) => {
      await write(join(outer, 'package.json'), JSON.stringify({ workspaces: ['**'] }));
      await write(join(outer, 'pnpm-lock.yaml'));
      const repo = join(outer, 'repo');
      await mkdir(join(repo, '.git'), { recursive: true });
      const app = join(repo, 'app');
      await write(join(app, 'package.json'), '{}');

      expect(await findWorkspaceRoot(app)).toBeNull();
      expect((await detectPackageManager(app)).lockfile).toBeNull();
      // The repository root itself does not search upward either.
      expect(await findWorkspaceRoot(repo)).toBeNull();
    });
  });
});
