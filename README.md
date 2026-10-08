# Local CI Runner

Run CI-style validation locally before pushing to GitHub or Azure DevOps.

> `npx local-ci run`

Local CI Runner is an npm CLI with a framework-agnostic core and framework adapters.

## Phase 2 status

Phase 2 delivers the CI execution engine. The core flow is:

```
CLI
 ↓
PipelineRunner          sequential execution, failFast, overall result
 ↓
StepRunner               per-step lifecycle, timeout, cancellation
 ↓
ProcessRunner            one child process: capture, timeout, termination
 ↓
local process
```

Implemented and verified:

- Structured process results (exit code, signal, stdout, stderr, duration, timeout and cancellation state)
- Per-step timeouts with child termination
- Cancellation via `AbortSignal`, surfaced as `CANCELLED`
- `failFast` for pipelines
- Per-step log files alongside JSON and HTML reports
- Secret masking in captured output and in reported command lines
- Step lifecycle and result model extended with `CANCELLED`
- Vitest coverage for the process, step and pipeline layers

Still intentionally absent: framework adapters, Azure YAML, Docker and AI analysis.

## Quick start

```bash
npm install
npm run build
npm link

cd /path/to/your/project
local-ci init
local-ci validate
local-ci doctor
local-ci run
```

The package can also be invoked after publishing with:

```bash
npx local-ci init
npx local-ci run
```

## Configuration

Create `.local-ci.yml`:

```yaml
version: 1

project:
  type: angular

pipeline:
  - install
  - typecheck
  - test
  - coverage
  - lint
  - build
  - security

settings:
  failFast: false
  timeoutMs: 300000
```

### settings.failFast

- `false` (default) — every step runs; a failure does not stop later steps.
- `true` — the pipeline stops after the first failure or unsupported step, and every
  later step is reported as `SKIPPED`. Skipped steps are never reported as executed.

### settings.timeoutMs

Optional per-step time limit in milliseconds. Omit it to run steps without a time
limit. When the limit is reached the child process is terminated, the step fails with
`timedOut: true`, and the error states the limit, e.g. `Step timed out after 300s`.

A timeout fails the step. It is never reported as a pass, and it is never silently
converted into a generic failure.

## Pipeline execution lifecycle

Each step moves through the lifecycle and ends in exactly one terminal status:

| Status | Meaning |
|---|---|
| `PASS` | The step completed successfully. |
| `FAIL` | The step failed, threw, or timed out. |
| `UNSUPPORTED` | No implementation is registered for the step. |
| `SKIPPED` | The step was not run because of `failFast` or cancellation. |
| `CANCELLED` | The step was interrupted by cancellation (Ctrl+C). |

An `UNSUPPORTED` step always makes the pipeline non-successful. Missing functionality is
never reported as a pass.

## Cancellation

Pressing Ctrl+C (SIGINT) during `local-ci run`:

1. aborts the pipeline through an `AbortController`,
2. terminates the running child process,
3. marks the active step `CANCELLED`,
4. marks every remaining step `SKIPPED`,
5. still writes reports and logs,
6. exits with a non-zero status.

Cancellation is distinct from failure and is reported as `CANCELLED`. Signal handlers
are installed once per command and always removed afterwards, so repeated runs do not
accumulate listeners.

## Exit codes

- `0` — the pipeline succeeded: every executed step is `PASS`.
- non-zero — the pipeline did not succeed. This includes `FAIL`, `UNSUPPORTED`,
  `CANCELLED` and timeouts.

`SKIPPED` steps do not change the outcome on their own; they follow an existing failure
or cancellation.

## Reports and logs

Every run writes an artifact directory under the project:

```
.local-ci/
  reports/
    <run-id>/
      report.json
      report.html
      logs/
        <step-id>.log
```

Each step log records status, duration, start and end time, the masked command line,
exit code, signal, timeout and cancellation state, the error, and captured stderr and
stdout. `local-ci report <run-id>` reprints a saved run.

Process execution and file persistence are separate: `ProcessRunner` produces data and
knows nothing about reports, HTML or the log layout.

## Security model

- Commands are executed as an executable plus an argument vector. No shell is invoked and
  no command string is built from configuration values.
- Captured output is truncated and masked: values of environment variables whose names
  look like credentials, and values passed to credential-style flags such as `--token`,
  are replaced with `***`.
- The environment is never serialized into reports or logs.
- Secret values are read only to mask them. They are never stored on a result object and
  never written to disk.
- There is no telemetry, no source upload and no secret collection.

`local-ci doctor` distinguishes a tool that is not installed from one that could not be
checked because process execution was blocked. It never marks an unchecked tool as a pass.

## Architecture notes

- `src/core/process-runner.ts` — one child process. Never throws for process failures;
  a missing executable, non-zero exit, timeout and cancellation all resolve to a
  structured result.
- `src/core/process-step.ts` — generic adapter bridge: turns a command plus arguments
  into a `PipelineStep`. Adapters decide *which* command to run; this decides *how*.
- `src/core/step-runner.ts` — step lifecycle, timeout and cancellation. Always resolves
  to a structured result; a thrown exception can never become `PASS`.
- `src/core/pipeline-runner.ts` — ordering, `failFast`, aggregation and the overall result.

## Roadmap

1. CLI foundation — done
2. CI engine: timeouts, cancellation, logging — done
3. Angular adapter: dependency checks, typecheck, tests, coverage, lint, build
4. Console/JSON/HTML reporting expansion
5. Azure DevOps YAML adapter/importer with explicit unsupported-task results

Docker and AI integrations remain optional future features.

## Development

```bash
npm run typecheck
npm test
npm run build
node demo/phase2-demo.mjs
```

The demo exercises PASS, FAIL, `failFast` both ways, unsupported steps, timeout,
cancellation and credential masking against deterministic commands.