import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { localCiConfigSchema } from '../../src/config/schema.js';
import { adapterFor } from '../../src/ecosystems/registry.js';

const templates = join(process.cwd(), 'templates');

describe('shipped templates', () => {
  it('every template in templates/ is a valid configuration', async () => {
    const files = (await readdir(templates)).filter((name) => name.endsWith('.yml'));
    expect(files).toEqual(expect.arrayContaining(['local-ci.yml', 'monorepo.local-ci.yml']));
    for (const file of files) {
      const result = localCiConfigSchema.safeParse(parse(await readFile(join(templates, file), 'utf8')));
      expect(result.success, `${file}: ${result.success ? '' : JSON.stringify(result.error.issues)}`).toBe(true);
    }
  });

  it('the monorepo template only uses step ids its ecosystem actually implements, and recognised types', async () => {
    const config = localCiConfigSchema.parse(parse(await readFile(join(templates, 'monorepo.local-ci.yml'), 'utf8')));
    expect(config.projects?.length).toBeGreaterThan(1);
    for (const project of config.projects ?? []) {
      const adapter = adapterFor(project.type);
      expect(adapter, `${project.name}: ${project.type}`).toBeDefined();
      for (const id of project.pipeline) {
        const defined = Object.hasOwn(project.steps ?? {}, id);
        expect(defined || adapter!.stepIds().includes(id), `${project.name}.${id}`).toBe(true);
      }
    }
  });
});
