#!/usr/bin/env node
/**
 * Fails when a vitest JSON report contains a skipped test that is not expected.
 *
 * A skipped real-toolchain test is a test that did not happen. The only skips
 * accepted are the "tool is absent or broken" cases, which by construction
 * cannot run on a machine where the tool is installed (see ALLOWED below). Every
 * skip is listed in the log and the GitHub step summary, expected or not.
 *
 * Usage: node scripts/check-skips.mjs <vitest-report.json>
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Skips that are expected on a fully provisioned runner, matched on the full test name. */
export const ALLOWED = [
  /a dotnet that exists but cannot run is BLOCKED/,
  /a Maven project without mvn or a wrapper is BLOCKED/,
  /a Gradle project without gradle or a wrapper is BLOCKED/,
];

export function classify(report) {
  const skipped = [];
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      if (test.status === 'skipped' || test.status === 'pending' || test.status === 'todo') {
        skipped.push({ file: file.name, name: test.fullName ?? test.title });
      }
    }
  }
  return {
    expected: skipped.filter((test) => ALLOWED.some((pattern) => pattern.test(test.name))),
    unexpected: skipped.filter((test) => !ALLOWED.some((pattern) => pattern.test(test.name))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: check-skips.mjs <vitest-report.json>');
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const { expected, unexpected } = classify(report);
  const lines = [
    '## Skipped tests',
    '',
    `Expected skips (a tool that is absent or broken cannot be tested where it is installed): ${expected.length}`,
    ...expected.map((test) => `- ${test.name}`),
    '',
    `**Unexpected skips: ${unexpected.length}**`,
    ...unexpected.map((test) => `- **UNEXPECTED SKIP** ${test.name}`),
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (unexpected.length > 0) {
    console.error(`\n${unexpected.length} test(s) were skipped but are not on the expected list: those tests did not run.`);
    process.exit(1);
  }
}
