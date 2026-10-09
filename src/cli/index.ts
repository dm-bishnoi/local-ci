#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { validateCommand } from './commands/validate.js';
import { doctorCommand } from './commands/doctor.js';
import { preflightCommand } from './commands/preflight.js';
import { reportCommand } from './commands/report.js';

const program = new Command();

program
  .name('local-ci-runner')
  .description('Run CI-style validation locally before pushing to CI providers.')
  .version('0.1.0');

program.command('init')
  .description('Create a .local-ci.yml configuration')
  .option('--force', 'replace an existing configuration')
  .action(async (options: { force?: boolean }) => initCommand(process.cwd(), options.force));

program.command('validate')
  .description('Validate .local-ci.yml')
  .action(async () => validateCommand(process.cwd()));

program.command('doctor')
  .description('Check the local environment and project configuration')
  .action(async () => {
    const code = await doctorCommand(process.cwd());
    if (code !== 0) process.exitCode = code;
  });

program.command('preflight')
  .description('Check whether the configured pipeline can reasonably run on this machine')
  .action(async () => {
    const code = await preflightCommand(process.cwd());
    if (code !== 0) process.exitCode = code;
  });

program.command('run')
  .description('Run the configured local CI pipeline')
  .action(async () => {
    const code = await runCommand(process.cwd());
    if (code !== 0) process.exitCode = code;
  });

program.command('report')
  .description('Display a saved report')
  // Optional at the parser level so that omitting it produces this command's
  // own message — usage plus the run ids that actually exist — instead of a
  // bare commander "missing required argument" error.
  .argument('[run-id]', 'run id to display, as printed by "local-ci-runner run"')
  .addHelpText(
    'after',
    '\nExamples:\n  local-ci-runner report 20261008-123456-abcd1234\n  local-ci-runner report            # lists available runs\n\n' +
      'Reports are stored under .local-ci/reports/ in your project, one directory per run.',
  )
  .action(async (runId?: string) => {
    const code = await reportCommand(process.cwd(), runId);
    if (code !== 0) process.exitCode = code;
  });

program.command('version')
  .description('Print the local-ci-runner version')
  .action(() => console.log('0.1.0'));

program.parseAsync().catch((error: unknown) => {
  console.error(`local-ci-runner: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
