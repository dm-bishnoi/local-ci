# Local CI Runner

Run CI-style validation locally before pushing to GitHub or Azure DevOps.

> `npx local-ci run`

Local CI Runner is an npm CLI with a framework-agnostic core and framework adapters.

## Phase 3 status

Phase 3 adds the **Angular adapter**. The core engine still knows nothing about Angular:

```
local-ci run
      ↓
detect project (angular.json, package.json, lockfile)
      ↓
Angular adapter resolves each logical step to a local command
      ↓
StepRegistry  ← core only ever sees PipelineStep objects
      ↓
Phase 2 engine: PipelineRunner → StepRunner → ProcessRunner → local process
```

`src/adapters/angular/` is the only Angular-aware code. A React, Vue or Node
adapter would follow the same shape without touching the engine.

Implemented and verified:

- Angular detection from `angular.json` and Angular packages in `package.json`
- Deterministic package-manager detection for npm, pnpm and yarn
- Command mapping for install, typecheck, test, coverage, lint, build and security
- Steps that run real commands, or report `UNSUPPORTED` with a reason
- Automatic detection and registration during `local-ci run`
- Angular adapter test coverage

Azure DevOps, Docker, AI and other frameworks remain out of scope.

## Angular support

### Detection

A project is Angular when `angular.json` exists, or when `package.json` declares
`@angular/core`, `@angular/cli`, `@angular/build` or `@angular-devkit/build-angular`.
A TypeScript project with neither is not treated as Angular. If
`.local-ci.yml` says `project.type: angular` but Angular is not found, the run
**fails with a diagnostic** instead of executing unrelated commands.

A UTF-8 BOM in `package.json` is tolerated, because Windows editors add one and
`npm` accepts it.

### Package manager

Resolved from the lockfile, in this fixed order:

| Lockfile | Manager |
|---|---|
| `package-lock.json` | npm |
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |

With no lockfile, npm is used and the run reports that the choice was a default.
The adapter never installs or switches package managers, and never falls back
to a different one: if the detected manager is unavailable the step fails.

### Step mapping

Every mapping is either a real command or an explicit `UNSUPPORTED`. Nothing is
assumed to exist, and nothing is reported as passing without having run.

| Step | Report name | Resolution |
|---|---|---|
| `install` | Dependencies | `npm ci` with a lockfile, otherwise `npm install`; `pnpm install --frozen-lockfile` and `yarn install --frozen-lockfile` with their lockfiles |
| `typecheck` | TypeScript | `run typecheck` if the script exists, otherwise `UNSUPPORTED` |
| `test` | Unit Tests | `run test` if the script exists, otherwise `UNSUPPORTED` |
| `coverage` | Coverage | `run coverage`, else `run test` plus `--coverage` when a coverage provider is declared, otherwise `UNSUPPORTED` |
| `lint` | Lint | `run lint` if the script exists, otherwise `UNSUPPORTED` |
| `build` | Production Build | `run build` if the script exists, else the local `ng build` via `npx --no-install` / `pnpm exec` / `yarn exec` |
| `security` | Security | `npm audit --json` or `pnpm audit --json`; `UNSUPPORTED` for yarn |

Notes:

- A project created by `ng new` ships `build` and `test` scripts but no
  `typecheck`, `lint` or `coverage` script, so those steps report `UNSUPPORTED`
  with a reason. Add the scripts to enable them.
- The Angular CLI fallback uses `npx --no-install`, so it can never fetch a
  package from a registry. It only applies when `angular.json` exists and
  `@angular/cli` is declared.
- Coverage is only forwarded when a real provider is declared. No coverage
  percentage is ever invented.
- `install` never modifies `package.json` or updates dependencies. `npm ci` is
  strict about the lockfile being in sync with `package.json`, which is the
  desired behaviour for CI.

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
- A package manager is never installed, switched, or silently replaced
- `npm audit` contacts the npm registry to check advisories, which is the point
  of the step; nothing else is uploaded and no telemetry is sent
- Secret values are read only to mask them. They are never stored on a result
  object and never written to disk.
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
3. Angular adapter — done
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