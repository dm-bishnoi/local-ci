# Local CI Runner

Run CI-style validation locally before pushing to GitHub or Azure DevOps.

> `npx local-ci run`

Local CI Runner is an npm CLI with a framework-agnostic core and framework adapters.

## Phase 4.5 status

Phase 4.5 adds **preflight, doctor and environment readiness**. The loop is now:

```
detect → preflight → run → diagnose → report → re-run
```

The product principle behind it: **DETECT → SOLVE/GUIDE → VERIFY**. A condition that
could not be verified is reported as unverified, never as a pass, and a blocked or
unsupported condition is never converted into `PASS`.

```
local-ci preflight
      ↓
blocking condition?
      ├─ yes → report BLOCKED → do not execute the affected steps
      └─ no  → execute the pipeline
```

New commands:

- `local-ci doctor` — diagnostic only. Audits the environment, the project and the
  configuration. It never executes a pipeline step, never installs anything and never
  modifies the project.
- `local-ci preflight` — "can this configured pipeline reasonably run here?" Runs the
  same checks that gate `local-ci run`, for a human.
- `local-ci run` — now runs preflight first. Blocking conditions prevent the affected
  steps from executing and are reported as `BLOCKED`; warnings inform but never block.

Each run's report now also carries an **environment fingerprint** (OS, architecture,
Node, package manager, Git, Angular, browsers, CI/local marker) and the **preflight
result** that gated it, so a saved report is self-describing.

## Phase 4 status

Phase 4 delivers the **reporting layer**. Every run — successful, failed, timed
out, cancelled or unsupported — produces a complete, durable set of artifacts:

```
local-ci run
      ↓
PipelineRunner          collected StepResults
      ↓
Report Model            one pass: derive, redact, bound
      ↓
  ├── Console          the report you read in the terminal
  ├── JSON             report.json    complete, machine-readable
  ├── Summary          summary.json   small, machine-readable
  ├── HTML             report.html    self-contained dashboard
  └── Logs             logs/<step>.log complete per-step output
```

The Report Model is the only place that derives a status, masks a secret or
truncates output. Reporters render; they never re-derive, so two reporters
cannot disagree, and no reporter can accidentally serialize more than the model
allows.

Implemented and verified:

- `report.json`, `summary.json`, `report.html` and `logs/` for every run
- Log files only for steps that actually executed — no fabricated evidence
- `PASS` / `FAIL` / `UNSUPPORTED` / `SKIPPED` / `CANCELLED` preserved everywhere
- Console report that reads correctly without colour, with ora only for live progress
- Self-contained HTML dashboard with no frontend framework and no new dependency
- Coverage read from a real Istanbul summary, or reported honestly as missing
- Redaction of environment secrets, credential flags and URL-embedded passwords
- Reporting failures isolated: a broken artifact never destroys the run result
- `local-ci report <run-id>`, with safe run-id handling and readable errors

Azure DevOps, Docker, AI and other frameworks remain out of scope.

## Angular support

The core engine knows nothing about Angular. All Angular awareness lives in
`src/adapters/angular/`:

```
local-ci run
      ↓
detect project (angular.json, package.json, lockfile)
      ↓
Angular adapter resolves each logical step to a local command
      ↓
StepRegistry  ← core only ever sees PipelineStep objects
      ↓
PipelineRunner → StepRunner → ProcessRunner → local process
      ↓
Report Model → Console / JSON / Summary / HTML / Logs
```

A React, Vue or Node adapter would follow the same shape without touching the
engine or the reporting layer.

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

## Quick start

```bash
npm install
npm run build
npm link

cd /path/to/your/project
local-ci init
local-ci validate
local-ci doctor
local-ci preflight
local-ci run

local-ci report <run-id>   # reopen a stored run
```

`doctor` diagnoses the machine and the project. `preflight` answers the one question
that decides whether `run` should start. `run` performs that same preflight itself
before executing anything.

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

environment:
  variables:
    required:
      - DATABASE_URL
      - API_URL
```

### environment.variables.required

Names of environment variables the pipeline needs. Only presence is checked — local-ci
never reads, prints or stores their values, and it never loads `.env` files for you.
A missing required variable is `BLOCKED`: the run reports it and does not execute the
affected steps.

If `.env.example` exists, its variable *names* are used purely as guidance, so the
recommendation can tell you to copy the example. Its values are discarded on read.

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

Each step moves through the lifecycle and ends in exactly one terminal status. See
[Step statuses](#step-statuses) for what each one means and whether it gets a log
file.

An `UNSUPPORTED` step always makes the pipeline non-successful. Missing functionality is
never reported as a pass.

## Cancellation

Pressing Ctrl+C (SIGINT) during `local-ci run`:

1. aborts the pipeline through an `AbortController`,
2. terminates the running child process **and its process tree** (see
   [Process-tree cleanup](#process-tree cleanup)),
3. marks the active step `CANCELLED`,
4. marks every remaining step `SKIPPED`,
5. still writes reports and logs,
6. exits with a non-zero status.

Cancellation is distinct from failure and is reported as `CANCELLED`. Signal handlers
are installed once per command and always removed afterwards, so repeated runs do not
accumulate listeners.

## Exit codes

- `0` — success. For `run`, the pipeline succeeded: every step is `PASS`. For
  `doctor` and `preflight`, the verdict is `PASS` or `WARNING` — warnings inform and
  never fail a command.
- non-zero — the run did not succeed (`FAIL`, `BLOCKED`, `UNSUPPORTED`, `CANCELLED`,
  `TIMEOUT`, `ERROR`), or `doctor`/`preflight` found a `BLOCKED` or `ERROR` verdict.

There is no "partial success" state. `BLOCKED`, `UNSUPPORTED`, `SKIPPED`, `TIMEOUT`,
`CANCELLED` and `ERROR` are all non-zero, and none of them is ever reported as `PASS`.

`SKIPPED` steps do not change the outcome on their own; they follow an existing failure
or cancellation.

## Doctor

```bash
local-ci doctor
```

Doctor is **diagnostic only** — it never executes the pipeline. It checks:

- **Environment** — OS/architecture, Node version against `engines.node` or `.nvmrc`,
  npm/pnpm/yarn and Git availability, browser detection, Angular detection.
- **Project** — `package.json`, `angular.json` (when Angular is declared), lockfile
  and which package manager it implies, dependency installation state, package manager
  declared in `packageManager` versus the lockfile.
- **Configuration** — `.local-ci.yml` exists, parses and validates; configured
  pipeline steps are identified as known or unsupported.
- **Requirements** — declared required environment variables, presence only.

Every check is reported as one of:

| Severity | Meaning |
|---|---|
| `PASS` | Verified good — the check actually ran and the answer is yes. |
| `WARNING` | Off but workable; the pipeline can still run. |
| `BLOCKED` | A known requirement prevents execution. |
| `UNSUPPORTED` | local-ci cannot perform this capability. |
| `ERROR` | The check itself failed; the answer is genuinely unknown. |
| `UNKNOWN` | Deliberately unverified — reported, never promoted to `PASS`. |

A requirement that could not actually be verified is reported as `UNKNOWN` or
`WARNING`, never as satisfied.

## Preflight

```bash
local-ci preflight
```

Preflight answers: "Can this configured pipeline reasonably run on this machine?"

```
LOCAL CI PREFLIGHT

ENVIRONMENT
  ✓ Node version           PASS
  ✓ npm                    PASS
  ✓ Browser                PASS

PROJECT
  ✓ package.json           PASS
  ✓ .local-ci.yml          PASS
  ✓ dependencies           PASS

REQUIREMENTS
  ✓ API_URL                PASS
  ⚠ DATABASE_URL           [WARNING]

PIPELINE
  ✓ Pipeline               PASS

Preflight: WARNING

Recommendation:
  Set DATABASE_URL before running the pipeline.
```

How `run` uses it:

1. preflight runs before any step is executed,
2. a `BLOCKED` condition prevents the affected steps from executing — they are
   reported as `BLOCKED` with the reason, and the run exits non-zero,
3. `UNSUPPORTED` steps are reported and still make the run non-zero, but they do not
   stop the rest of the pipeline,
4. warnings never block — the pipeline runs and the warnings are recorded in the
   report.

A blocker scoped to particular steps (for example a missing browser) blocks only
those steps: `test` can be blocked while `install` and `build` still run.

## Environment fingerprint

Every run records an environment fingerprint in its report: OS/platform, architecture,
Node version, package manager and version, Git version, Angular (declared vs
installed), browsers, project/framework, and a CI/local indicator derived from
well-known CI marker *presence*.

The fingerprint has no field that can carry a secret: no environment variable values,
no `.env` contents, no credentials, no tokens. Comparing a local fingerprint against a
CI one is future work; the shape is recorded now so reports are self-describing.

## Browser detection

For Angular/browser projects, local-ci looks for Chrome and Chromium in the standard
install locations for each platform — Windows (`Program Files`, `%LOCALAPPDATA%`),
macOS (`/Applications`) and Linux (`/usr/bin`, `/snap/bin`, …) — rather than one
hard-coded path. Detection is a filesystem check; nothing is launched.

- A project that declares a browser-driven runner (Karma, Protractor, Cypress, …)
  with no browser found → `BLOCKED` for the test steps, with guidance to install one.
- A project that runs tests but declares no browser-driven runner → `WARNING`.
- Otherwise the absence of a browser is noted and does not block.

local-ci never installs software automatically. If detection is unreliable the result
is a warning or unknown, not a pass.

## Node version requirements

`engines.node` and `.nvmrc` are checked with a deliberately small range checker (no
semver dependency). Supported: comparators like `>=20`, `>=18 <21`, `20.x`, exact
versions. A range the checker cannot evaluate with confidence is reported as
`UNKNOWN` with guidance to verify manually — local-ci does not claim compatibility it
could not check.

## Process-tree cleanup

A pipeline step is usually a package-manager shim that launches `node`, which may
launch a bundler. Killing only the direct child leaves those descendants running and
holding the CLI's output handles open — observed on Windows in the Phase 4 E2E, where
a timed-out `npm` shim kept the CLI alive.

local-ci terminates the whole process tree on timeout and on cancellation:

- **Windows** — `taskkill /T /F` walks the tree rooted at the step's pid.
- **macOS/Linux** — steps are spawned as process-group leaders (`detached`), so one
  signal to the negated pid reaches every descendant.

Termination is polite first (`TERM`), then forced after a grace period. No orphaned
grandchildren should remain when local-ci exits. Platform-specific behaviour is
covered by integration tests where the OS allows it; the rest is documented rather
than guessed.

## Known limitations

- Only Angular projects have an adapter. Other frameworks report `UNSUPPORTED`.
- The range checker covers a subset of semver syntax; anything else is `UNKNOWN`.
- Browser detection checks known install locations; a browser installed elsewhere is
  not found (and is reported as such, never as a pass).
- `.env` files are never loaded — set required variables in your shell.
- Comparing a local run against CI is not implemented yet; the fingerprint is recorded
  for it.

Local CI helps you **run CI-style validation locally before pushing.** It does not
promise 100% CI parity, it is not a CI replacement, and it cannot guarantee identical
CI results — CI environments differ in ways no local tool can fully reproduce.

## Step statuses

Every run writes an artifact directory under the project — never in an OS temp
directory, so a report is still readable after the run:

```
.local-ci/
  reports/
    20261008-123456-abcd1234/
      report.json
      summary.json
      report.html
      logs/
        install.log
        typecheck.log
        test.log
        build.log
```

A run id is `YYYYMMDD-HHmmss-<8 hex>`. Ids sort chronologically as plain strings
and two runs in the same second still get separate directories.

### report.json

The complete machine-readable record: run id, project, framework, package
manager, status, canonical outcome, start and end time, duration, exit code,
coverage, per-status counts (including `blocked`, `error` and `timeout`), the
environment fingerprint, the preflight that gated the run, and every step with
its status, outcome, duration, exit code, signal, timeout and cancellation
state, command line, error and log path.

stdout and stderr are included as bounded excerpts so the file stays small. The
complete output is in the step's log, which `logPath` points at.

### summary.json

A small, flat digest for quick consumption by another tool — no step output, no
nesting:

```json
{
  "schemaVersion": 1,
  "runId": "20261008-123456-abcd1234",
  "status": "FAIL",
  "exitCode": 1,
  "durationMs": 4458,
  "projectName": "smoke-app",
  "framework": "angular",
  "packageManager": "npm",
  "coverage": { "status": "unsupported", "percent": null },
  "steps": {
    "total": 3,
    "passed": 2,
    "failed": 1,
    "unsupported": 0,
    "skipped": 0,
    "cancelled": 0,
    "blocked": 0,
    "error": 0,
    "timeout": 0
  },
  "failures": [
    { "id": "build", "name": "Production Build", "outcome": "FAIL", "reason": "..." }
  ]
}
```

When collected, the environment fingerprint (`environment`) and the gating
preflight (`preflight`) are included here too. Both are derived once in the
report model; no reporter re-derives them.

A tool can decide whether a run passed by reading only this file.

### report.html

A dashboard with a header (run id, project, framework, package manager,
timestamps, overall status, duration, exit code), summary cards, a step table
(step, status, duration, exit code, details), expandable per-step output for
failures, a separate section for unsupported capabilities, a section for skipped
steps, and links to every step log.

It is a single self-contained file: hand-written HTML plus one inline `<style>`.
No frontend framework, no build step, no network fetch — it opens correctly from
disk forever.

### logs

One log per **executed** step, holding that step's complete captured output
within the Phase 2 capture cap:

```
# step: Production Build (build)
status: FAIL
duration: 1540 ms
command: npm run build
exitCode: 1

--- error ---
Command failed with exit code 1: npm run build

--- stderr ---
ERROR: Application bundle generation failed.
```

`UNSUPPORTED` and `SKIPPED` steps never ran, so they get **no log file**. Their
reason is carried in `report.json` and shown in the HTML report instead. Writing
a log for a step that never executed would be fabricated evidence.

### Reading a report back

```bash
local-ci report 20261008-123456-abcd1234
```

Prints the stored run's console report. Run the command with no argument to list
the run ids that exist. An unknown or malformed run id produces one readable
sentence — never a stack trace — and exits non-zero. Run ids are validated before
they reach the filesystem, so a value like `../../etc/passwd` is rejected.

### Reporting failures

Reports are generated for failed, timed-out, cancelled and unsupported runs. The
report is most valuable exactly when CI fails.

If writing an artifact fails, the original pipeline result still governs the
outcome, each artifact is attempted independently, a clear reporting error is
printed, and the exit code is non-zero. Reporting can only ever *add* a failure;
it can never turn a failing run into a reported `PASS`.

## Coverage

Coverage is reported only when a real coverage tool produced a number.

Local CI reads the Istanbul summary report at `coverage/coverage-summary.json`
and uses `total.lines.pct`. That format has a fixed, documented schema, so the
value is parsed rather than guessed. Output is never scraped with a regex to
manufacture a percentage, and a stale summary left by an earlier run is never
adopted — the file is consulted only when this run's coverage step passed.

Three states, kept distinct:

| State | Meaning |
|---|---|
| `84.72%` | A measured percentage, with its source file named. |
| `unavailable` | Coverage ran but produced no summary. Something is missing from the project. |
| `UNSUPPORTED` | There is no coverage step, or the adapter declined to run one. Nothing was attempted. |

`0%` is only ever shown when coverage genuinely measured zero. No measurement is
never reported as `0%`.

## Step statuses

| Status | Meaning | Log file? |
|---|---|---|
| `PASS` | The step completed successfully. | yes |
| `FAIL` | The step failed, threw, or timed out (`timedOut: true`). | yes |
| `BLOCKED` | A known requirement (tool, variable, capability) prevented execution. | no |
| `UNSUPPORTED` | local-ci cannot execute this capability. Nothing ran. | no |
| `SKIPPED` | Not run, because of `failFast` or cancellation. | no |
| `CANCELLED` | Interrupted by cancellation (Ctrl+C). | yes |
| `ERROR` | An unexpected internal/system error prevented a meaningful verdict. | no |

The canonical run outcomes add `TIMEOUT`: the engine reports a timeout as `FAIL` with
`timedOut: true`, and reporting classifies it as its own outcome so the cause stays
visible instead of hiding inside "failed".

These are never collapsed into each other, in the console, in JSON or in HTML:

```
BLOCKED ≠ PASS    UNSUPPORTED ≠ PASS    SKIPPED ≠ PASS
TIMEOUT ≠ PASS    CANCELLED ≠ PASS      ERROR ≠ PASS
```

Only `PASS` is success, and only an all-`PASS` run exits zero.
`Coverage UNSUPPORTED` is a different fact from `Build FAIL` and from
`Security SKIPPED`, and the HTML report gives unsupported steps their own section
that states plainly that they did not run.

## Security model

- Commands are executed as an executable plus an argument vector. No shell is invoked and
  no command string is built from configuration values.
- Captured output is truncated and masked: values of environment variables whose names
  look like credentials, and values passed to credential-style flags such as `--token`,
  are replaced with `***`.
- Passwords embedded in URLs are masked structurally. A tool that prints
  `postgres://admin:s3cr3t@db.internal` has told us nothing to match against, but
  userinfo is a defined part of the URL grammar, so the password is masked while
  the host and user remain readable.
- Masking runs before truncation, so a limit can never slice a mask in half and leave a
  partial secret visible.
- Redaction is applied twice and independently: once when output is captured, and
  again when the report model is built. A step that produces output by some route
  other than a captured child process is still covered.
- `.env` files are never read. Nothing in the reporting path opens them.
- Environment variable *values* are never serialized into reports or logs, and
  absolute paths are never recorded. The only environment-derived facts that reach a
  report are tool versions and a CI/local boolean — see the environment fingerprint.
- Required environment variables are checked for presence only; their values are
  never read, printed or stored.
- Every value interpolated into `report.html` is HTML-escaped, so an error message
  containing `<script>` is displayed rather than executed.
- A package manager is never installed, switched, or silently replaced
- `npm audit` contacts the npm registry to check advisories, which is the point
  of the step; nothing else is uploaded and no telemetry is sent
- Secret values are read only to mask them. They are never stored on a result
  object and never written to disk.
- There is no telemetry, no source upload and no secret collection.

`local-ci doctor` distinguishes a tool that is not installed from one that could not be
checked because process execution was blocked. It never marks an unchecked tool as a pass.

## Architecture notes

### Core (framework-agnostic)

- `src/core/process-runner.ts` — one child process. Never throws for process failures;
  a missing executable, non-zero exit, timeout and cancellation all resolve to a
  structured result.
- `src/core/process-step.ts` — generic adapter bridge: turns a command plus arguments
  into a `PipelineStep`. Adapters decide *which* command to run; this decides *how*.
- `src/core/step-runner.ts` — step lifecycle, timeout and cancellation. Always resolves
  to a structured result; a thrown exception can never become `PASS`.
- `src/core/pipeline-runner.ts` — ordering, `failFast`, preflight-blocked steps, aggregation and the overall result.
- `src/core/status.ts` — the canonical result vocabulary: `StepStatus`, `RunOutcome`
  (including `TIMEOUT`), aggregation and exit-code rules. The non-`PASS` invariant lives here.
- `src/core/process-tree.ts` — cross-platform process-tree termination (taskkill on
  Windows, process-group signal on POSIX), used on timeout and cancellation.

### Diagnostics and environment

- `src/diagnostics/types.ts` — the shared severity model (`PASS`/`WARNING`/`BLOCKED`/`UNSUPPORTED`/`ERROR`/`UNKNOWN`),
  verdict derivation and blocker scoping. Only `BLOCKED` and `ERROR` block execution.
- `src/diagnostics/facts.ts` — read-only observations about the project on disk.
  Observations, not verdicts; doctor and preflight decide what they mean.
- `src/diagnostics/doctor.ts`, `preflight.ts` — the check sets behind `local-ci doctor`
  and `local-ci preflight`, and the gate `run` consults before executing.
- `src/env/fingerprint.ts` — the environment fingerprint. Structured so no field can
  carry a secret.
- `src/env/semver.ts` — deliberately small range checker; unresolvable ranges are
  `UNKNOWN`, never satisfied.
- `src/env/tools.ts`, `browser.ts` — three-state tool probes (found / missing /
  blocked) and cross-platform browser detection.

### Reporting

- `src/reporters/report-model.ts` — **the single derivation point**. Masks every string,
  bounds every excerpt, computes counts and coverage, and hands every reporter the same
  immutable model. Pure: no I/O, no mutation.
- `src/reporters/paths.ts` — deterministic artifact layout and run-id validation. Run ids
  are treated as untrusted on the way back in.
- `src/reporters/coverage.ts` — reads the Istanbul summary and derives the three coverage
  states. Never invents a number.
- `src/reporters/metadata.ts` — project facts the engine does not carry.
- `src/reporters/console.ts` — plain-text console report, plus the ora progress reporter
  used only while a step is genuinely in flight.
- `src/reporters/json.ts`, `summary.ts`, `html.ts`, `logs.ts` — renderers. Each one
  serializes the model and adds nothing of its own.
- `src/reporters/artifact.ts` — writes every artifact independently, so one failure
  cannot cost the others, and never throws away the run result.

Process execution, reporting and file persistence are separate: `ProcessRunner`
produces data and knows nothing about reports, HTML or the log layout.

## Roadmap

1. CLI foundation — done
2. CI engine: timeouts, cancellation, logging — done
3. Angular adapter — done
4. Console/JSON/HTML reporting expansion — done
5. Preflight / doctor / environment readiness — done
6. Azure DevOps YAML adapter/importer with explicit unsupported-task results — not started
7. Local-versus-CI fingerprint comparison — not started (fingerprint is recorded)

Docker and AI integrations remain optional future features.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
node demo/phase2-demo.mjs
node demo/phase4-cancel-e2e.mjs
node demo/phase4.5-process-tree.mjs
```

`demo/phase2-demo.mjs` exercises PASS, FAIL, `failFast` both ways, unsupported steps,
timeout, cancellation and credential masking against deterministic commands.

`demo/phase4-cancel-e2e.mjs` runs the **built** `dist/` output against a temporary
Angular project and cancels it mid-run, asserting that a cancelled run still writes
`report.json`, `summary.json`, `report.html` and only the log for the step that
actually ran.