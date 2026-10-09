import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderHtmlReport, writeHtmlReport } from '../../src/reporters/html.js';
import { makeBuilt, makeStep, withEnv, withTempProject } from '../helpers/reports.js';

const SECRET = 'sk-live-9f2a7c1b4e8d';

function render(steps: Parameters<typeof makeBuilt>[0], options = {}): string {
  return renderHtmlReport(makeBuilt(steps, options).report);
}

/**
 * Verifies that every non-void element opened in the document is closed, in
 * order. A real well-formedness check that needs no HTML parser and no
 * dependency.
 */
function assertBalancedMarkup(html: string): void {
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const stack: string[] = [];
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;

  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const [, closing, name, rest] = match;
    const tag = (name ?? '').toLowerCase();
    if (voids.has(tag)) continue;
    // A self-closing tag such as <br/> opens nothing.
    if (rest?.trimEnd().endsWith('/')) continue;

    if (closing) {
      expect(stack.pop(), `unexpected </${tag}>`).toBe(tag);
    } else {
      stack.push(tag);
    }
  }

  expect(stack, `unclosed tags: ${stack.join(', ')}`).toEqual([]);
}

describe('escapeHtml', () => {
  it('escapes every character that can break out of markup', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("it's & that")).toBe('it&#39;s &amp; that');
  });

  it('escapes ampersands before anything else, so entities are not doubled wrong', () => {
    expect(escapeHtml('a & < b')).toBe('a &amp; &lt; b');
  });
});

describe('renderHtmlReport structure', () => {
  it('produces a complete, balanced HTML document', () => {
    const html = render([makeStep('install', 'PASS'), makeStep('build', 'FAIL', { error: 'boom', exitCode: 1 })]);

    assertBalancedMarkup(html);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('</head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</body>');
    expect(html).toContain('</html>');
  });

  it('is self-contained: no external stylesheet, script or font', () => {
    const html = render([makeStep('install', 'PASS')]);

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('<style>');
  });

  it('renders the header with every documented fact', () => {
    const html = render([makeStep('install', 'PASS')]);

    expect(html).toContain('Local CI Runner');
    expect(html).toContain('20261008-123456-abcd1234');
    expect(html).toContain('my-angular-app');
    expect(html).toContain('angular');
    expect(html).toContain('npm');
    expect(html).toContain('PASS');
    expect(html).toContain('1m 16s');
    expect(html).toContain('Exit code');
  });

  it('renders the summary counts', () => {
    const html = render([
      makeStep('install', 'PASS'),
      makeStep('test', 'PASS'),
      makeStep('build', 'FAIL', { error: 'boom' }),
      makeStep('lint', 'UNSUPPORTED', { error: 'nope' }),
      makeStep('security', 'SKIPPED', { error: 'failFast' }),
    ]);

    for (const label of ['Total steps', 'Passed', 'Failed', 'Unsupported', 'Skipped', 'Cancelled']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Summary');
  });

  it('renders a step table with the documented columns', () => {
    const html = render([makeStep('install', 'PASS', { exitCode: 0 })]);

    for (const column of ['Step', 'Status', 'Duration', 'Exit code', 'Details']) {
      expect(html).toContain(`<th>${column}</th>`);
    }
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('</tbody>');
  });
});

describe('renderHtmlReport status rendering', () => {
  it('renders PASS', () => {
    const html = render([makeStep('install', 'PASS')]);
    expect(html).toContain('pill pass');
    expect(html).toContain('>PASS<');
  });

  it('renders FAIL', () => {
    const html = render([makeStep('build', 'FAIL', { error: 'boom', exitCode: 1 })]);
    expect(html).toContain('pill fail');
    expect(html).toContain('>FAIL<');
  });

  it('renders UNSUPPORTED', () => {
    const html = render([makeStep('lint', 'UNSUPPORTED', { error: 'No lint script.' })]);
    expect(html).toContain('pill unsupported');
    expect(html).toContain('>UNSUPPORTED<');
  });

  it('renders SKIPPED', () => {
    const html = render([makeStep('security', 'SKIPPED', { error: 'failFast is enabled.' })]);
    expect(html).toContain('pill skipped');
    expect(html).toContain('>SKIPPED<');
  });

  it('renders CANCELLED', () => {
    const html = render([makeStep('test', 'CANCELLED', { error: 'interrupted', cancelled: true })]);
    expect(html).toContain('pill cancelled');
    expect(html).toContain('>CANCELLED<');
  });

  it('labels every status in words, so colour is never the only signal', () => {
    const html = render([
      makeStep('install', 'PASS'),
      makeStep('build', 'FAIL', { error: 'x' }),
      makeStep('lint', 'UNSUPPORTED', { error: 'x' }),
      makeStep('security', 'SKIPPED', { error: 'x' }),
      makeStep('test', 'CANCELLED', { error: 'x' }),
    ]);

    for (const status of ['PASS', 'FAIL', 'UNSUPPORTED', 'SKIPPED', 'CANCELLED']) {
      expect(html).toContain(`>${status}</span>`);
    }
  });
});

describe('renderHtmlReport failure details', () => {
  it('shows error, stderr, stdout, exit code and timeout state', () => {
    const html = render([
      makeStep('build', 'FAIL', {
        command: 'npm run build',
        exitCode: 1,
        error: 'Process exited with code 1.',
        stderr: 'ERROR: Application bundle generation failed.',
        stdout: 'Building application...',
      }),
    ]);

    expect(html).toContain('Failed steps (1)');
    expect(html).toContain('Process exited with code 1.');
    expect(html).toContain('ERROR: Application bundle generation failed.');
    expect(html).toContain('Building application...');
    expect(html).toContain('Exit code: 1');
    expect(html).toContain('Timed out: no');
    expect(html).toContain('Cancelled: no');
    expect(html).toContain('npm run build');
  });

  it('states the timeout and cancellation state of a timed-out step', () => {
    const html = render([
      makeStep('test', 'FAIL', { timedOut: true, exitCode: null, signal: 'SIGTERM', error: 'Step timed out after 300s' }),
    ]);

    expect(html).toContain('Timed out: yes');
    expect(html).toContain('timed out');
    expect(html).toContain('signal SIGTERM');
    expect(html).toContain('Step timed out after 300s');
  });

  it('says so plainly when nothing failed', () => {
    const html = render([makeStep('install', 'PASS')]);
    expect(html).toContain('None. Every step that ran completed successfully.');
  });

  it('does not present an unsupported step as a failed step', () => {
    const html = render([
      makeStep('lint', 'UNSUPPORTED', { error: 'No "lint" script in package.json.' }),
    ]);

    expect(html).toContain('Unsupported capabilities (1)');
    expect(html).toContain('These steps were not run.');
    expect(html).toContain('different from a step that ran and failed');
    expect(html).not.toContain('Failed steps (1)');
    // The reason survives the round trip, with its quotes escaped.
    expect(html).toContain('No &quot;lint&quot; script in package.json.');
  });

  it('lists skipped steps separately', () => {
    const html = render([
      makeStep('build', 'FAIL', { error: 'boom' }),
      makeStep('security', 'SKIPPED', { error: 'Skipped because failFast is enabled.' }),
    ]);

    expect(html).toContain('Skipped steps (1)');
    expect(html).toContain('Skipped because failFast is enabled.');
  });
});

describe('renderHtmlReport logs', () => {
  it('links a log for each executed step', () => {
    const html = render([makeStep('install', 'PASS'), makeStep('build', 'FAIL', { error: 'boom' })]);

    expect(html).toContain('href="logs/install.log"');
    expect(html).toContain('href="logs/build.log"');
    expect(html).toContain('<h2>Logs</h2>');
  });

  it('offers no log link for a step that never ran', () => {
    const html = render([
      makeStep('install', 'PASS'),
      makeStep('lint', 'UNSUPPORTED', { error: 'nope' }),
      makeStep('security', 'SKIPPED', { error: 'failFast' }),
    ]);

    expect(html).toContain('href="logs/install.log"');
    expect(html).not.toContain('logs/lint.log');
    expect(html).not.toContain('logs/security.log');
    expect(html).toContain('no log');
  });

  it('offers expandable sections for output', () => {
    const html = render([makeStep('build', 'FAIL', { stderr: 'stack trace here', stdout: 'build log' })]);

    expect(html).toContain('<details');
    expect(html).toContain('<summary>');
    expect(html).toContain('</details>');
    expect(html).toContain('<pre');
  });

  it('says so when nothing executed, rather than showing an empty section', () => {
    const html = render([makeStep('lint', 'UNSUPPORTED', { error: 'nope' })]);
    expect(html).toContain('No step produced a log, because nothing was executed.');
  });
});

describe('renderHtmlReport coverage', () => {
  it('shows a measured percentage and its source', () => {
    const html = render([makeStep('coverage', 'PASS')], {
      coveragePercent: 84.72,
      coverageSource: 'coverage/coverage-summary.json',
    });

    expect(html).toContain('84.72%');
    expect(html).toContain('coverage/coverage-summary.json');
  });

  it('shows unavailable rather than 0% when nothing was measured', () => {
    const html = render([makeStep('coverage', 'PASS')]);

    expect(html).toContain('unavailable');
    expect(html).not.toContain('0.00%');
  });

  it('shows UNSUPPORTED with the reason', () => {
    const html = render([makeStep('coverage', 'UNSUPPORTED', { error: 'No coverage provider declared.' })]);

    expect(html).toContain('UNSUPPORTED');
    expect(html).toContain('No coverage provider declared.');
  });
});

describe('renderHtmlReport security', () => {
  it('escapes hostile output instead of rendering it', () => {
    const html = render([
      makeStep('build', 'FAIL', {
        error: '<script>alert("xss")</script>',
        stderr: '<img src=x onerror=alert(1)>',
        stdout: '</pre><script>bad()</script>',
      }),
    ]);

    assertBalancedMarkup(html);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('never leaks a secret from the environment', async () => {
    await withEnv('LOCAL_CI_TEST_AUTH_TOKEN', SECRET, () => {
      const html = render([
        makeStep('build', 'FAIL', {
          stdout: `using ${SECRET}`,
          stderr: `Authorization: Bearer ${SECRET}`,
          error: `token ${SECRET} rejected`,
        }),
      ]);

      expect(html).not.toContain(SECRET);
      expect(html).toContain('***');
    });
  });

  it('never leaks a password embedded in a connection string', () => {
    const html = render([
      makeStep('security', 'FAIL', { stderr: 'postgres://admin:s3cr3t-pw@db.internal/app unreachable' }),
    ]);

    expect(html).not.toContain('s3cr3t-pw');
    expect(html).toContain('postgres://admin:***@db.internal/app');
  });
});

describe('renderHtmlReport size', () => {
  it('stays bounded for a step with enormous output', () => {
    const html = render([makeStep('build', 'FAIL', { stdout: 'z'.repeat(500_000), stderr: 'y'.repeat(500_000) })], {
      excerptLimit: 1_000,
    });

    // Only the excerpt is embedded; the complete text stays in the log file.
    expect(html.length).toBeLessThan(60_000);
    expect(html).not.toContain('z'.repeat(20_000));
    expect(html).toContain('earlier character(s) omitted');
  });
});

describe('writeHtmlReport', () => {
  it('writes report.html into the run directory', async () => {
    await withTempProject(async (cwd) => {
      const built = makeBuilt([makeStep('build', 'FAIL', { error: 'boom' })]);
      const path = await writeHtmlReport(cwd, built.report);
      const html = await readFile(path, 'utf8');

      expect(path).toContain(`.local-ci${'\\'}reports${'\\'}20261008-123456-abcd1234${'\\'}report.html`);
      expect(html).toContain('Local CI Runner');
      assertBalancedMarkup(html);
    });
  });
});