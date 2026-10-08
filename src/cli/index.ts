#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { validateCommand } from './commands/validate.js';
import { doctorCommand } from './commands/doctor.js';
import { reportCommand } from './commands/report.js';

const program = new Command();

program
  .name('local-ci')
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

program.command('run')
  .description('Run the configured local CI pipeline')
  .action(async () => {
    const code = await runCommand(process.cwd());
    if (code !== 0) process.exitCode = code;
  });

program.command('report')
  .description('Display a saved report')
  .argument('<run-id>')
  .action(async (runId: string) => reportCommand(process.cwd(), runId));

program.command('version')
  .description('Print the local-ci version')
  .action(() => console.log('0.1.0'));

program.parseAsync().catch((error: unknown) => {
  console.error(`local-ci: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
