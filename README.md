# Local CI Runner

Run CI-style checks locally before pushing, for JavaScript/TypeScript (Node.js, Angular, React, Vue), .NET, Python, Java, PHP, Go and Rust, with preflight diagnostics and console, JSON, and HTML reports.

> `npx @dm-bishnoi/local-ci-runner run`

Local CI Runner is an npm CLI with a framework-agnostic core and one adapter per ecosystem. See [Languages and ecosystems](#languages-and-ecosystems) for exactly which checks each one runs, what they need, and what has and has not been verified against the real tools. GitHub Actions and Azure DevOps YAML are not interpreted: `.local-ci.yml` is the configuration.

## Languages and ecosystems

Local CI Runner detects a project, works out which checks it can really run, and runs
them with the project's own tools. It does not interpret CI YAML and it does not
guess: a check that the project is not set up for is reported, never assumed.

| Ecosystem | `project.type` values | Checks (step ids) |
|---|---|---|
| JavaScript / Node.js, TypeScript, React, Vue, Angular | `node`, `javascript`, `typescript`, `react`, `vue`, `angular` | `install`, `typecheck`, `test`, `coverage`, `lint`, `format`, `build`, `security` |
| .NET / C# | `dotnet`, `csharp` | `restore`, `build`, `test`, `format` |
| Python | `python` | `install` (explicit only), `test`, `lint`, `format`, `typecheck` |
| Java | `maven`, `gradle`, `java` | `compile`, `test`, `verify`, `build` |
| PHP | `php`, `composer` | `install`, `test`, `analyse`, `format` |
| Go | `go` | `format`, `vet`, `test`, `build` |
| Rust | `rust`, `cargo` | `check`, `test`, `build`, `format`, `lint` |

`type` is matched case-insensitively. JavaScript, TypeScript, React, Vue and Angular are
**one** ecosystem (Node.js) with different profiles: detecting a framework never removes
a check, and no framework is assumed to have a particular test runner or script.

### What each check runs

Every command is an executable plus an argument list. No shell is involved.

**Node.js family** (package manager from the lockfile: npm, pnpm, Yarn classic/Berry, Bun)

| Step | Command | Needs |
|---|---|---|
| `install` | `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile` (Berry: `--immutable`) / `bun install --frozen-lockfile` | a lockfile (otherwise BLOCKED: it would create one) |
| `typecheck`, `test`, `lint`, `build` | `<manager> run <script>` | the script in `package.json`. An explicit script **always** wins. |
| `coverage` | `<manager> run coverage`, else `<manager> run test -- --coverage` | a `coverage` script, or a `test` script plus a known coverage provider (`nyc`, `c8`, `jest`, `karma-coverage`, `@vitest/coverage-*`) |
| `format` | `<manager> run format:check` | a `format:check` script. A plain `format` script is never run: it may rewrite files. |
| `security` | `npm audit --json` / `pnpm audit --json` | npm or pnpm (Yarn and Bun: UNSUPPORTED). Contacts the registry. |

Without a script, a tool is **inferred** only when it is declared in `package.json`
*and* its configuration exists, and the report says so:

| Step | Inferred command | Evidence required |
|---|---|---|
| `typecheck` | `tsc --noEmit -p tsconfig.json` | `typescript` declared + a non-solution `tsconfig.json` |
| `typecheck` (Vue) | `vue-tsc --noEmit` | `vue-tsc` declared + `tsconfig.json` |
| `lint` | `eslint .` | `eslint` declared + an ESLint config |
| `format` | `prettier --check .` | `prettier` declared + a Prettier config |
| `test` | `vitest run` or `jest --ci` | exactly one of them declared + its config |
| `build` | `ng build` | Angular only: `angular.json` + `@angular/cli` |

Inferred tools run through `npx --no-install` / `pnpm exec` / `yarn exec` / `bun x
--no-install`, so nothing is fetched from a registry. **Angular projects get no
inferred fallbacks** beyond `ng build`; their commands are unchanged from earlier
versions.

**.NET** (`.sln`, `.slnx`, or one SDK-style `.csproj`/`.fsproj`/`.vbproj`)

| Step | Command |
|---|---|
| `restore` | `dotnet restore ./<target>` (`--locked-mode` when a `packages.lock.json` exists) |
| `build` | `dotnet build ./<target> --no-restore -c Release` |
| `test` | `dotnet test ./<target> --no-restore -c Release` — only when a project references `Microsoft.NET.Test.Sdk` or sets `IsTestProject` |
| `format` | `dotnet format ./<target> --verify-no-changes --no-restore` (SDK 6 or newer; `init` adds it only if an `.editorconfig` exists) |

Several solutions, or several projects and no solution, in one directory are BLOCKED
as ambiguous: point `project.path` at one. A `global.json` SDK version is required as a
minimum. Telemetry and the first-run banner are switched off.

**Python** — each tool needs evidence (its configuration, or a declared dependency;
comments do not count) **and** must import in the chosen interpreter

| Step | Command | Evidence |
|---|---|---|
| `test` | `python -m pytest` | `pytest.ini`, `[tool.pytest.ini_options]`, `[tool:pytest]`, `conftest.py`, or a declared dependency |
| `lint` | `python -m ruff check .` | `ruff.toml`, `[tool.ruff]`, or a declared dependency |
| `format` | `python -m ruff format --check .` | same as `lint` |
| `typecheck` | `python -m mypy [<package>]` | mypy configuration or dependency, plus a `files` setting or exactly one package |
| `install` | `<venv python> -m pip install -r requirements.txt`, `uv sync --locked`, or `poetry install --no-interaction --sync` | an existing `.venv`/`venv` with `requirements.txt`, or `uv.lock`/`poetry.lock` with that tool |

The interpreter is the project's `.venv` or `venv`, else `python3`/`python` (`py -3` on
Windows). Dependencies are **never** installed unless the pipeline lists `install`,
and `install` is never generated by `init` and never goes into a global interpreter.
`requires-python = ">=X.Y"` is enforced as a minimum.

**Java** — Maven or Gradle, wrapper first (`mvnw`/`gradlew`, `.cmd`/`.bat` on Windows)

| Step | Maven | Gradle |
|---|---|---|
| `compile` | `mvn -B compile` | `gradle --console=plain --no-daemon classes` |
| `test` | `mvn -B test` | `gradle … test` |
| `verify` | `mvn -B verify` | `gradle … check` |
| `build` | `mvn -B package -DskipTests` | `gradle … assemble` |

A JDK (`java`) is always required; a declared `release`/`java.version` of 9 or higher
becomes a minimum JDK. `pom.xml` together with `build.gradle` is BLOCKED as ambiguous.
A wrapper that is not executable or lacks its properties file is BLOCKED with the fix.
Wrappers download their pinned distribution on first use.

**PHP** (Composer)

| Step | Command | Evidence |
|---|---|---|
| `install` | `composer install --no-interaction --no-progress` | `composer.lock` (otherwise UNSUPPORTED) |
| `test` | `composer run-script test`, else `vendor/bin/phpunit --do-not-cache-result` | a `test` script, or `phpunit.xml(.dist)` + PHPUnit declared or installed |
| `analyse` | `vendor/bin/phpstan analyse --no-progress` | `phpstan.neon(.dist)` + PHPStan declared or installed |
| `format` | `vendor/bin/php-cs-fixer fix --dry-run --diff` or `vendor/bin/phpcs` | the tool's config + the tool declared or installed |

`steps.<id>.script` in a PHP project means a composer script. `composer.json`
`require.php` with a single lower bound is enforced as a minimum PHP.

**Go** (`go.mod`, or `go.work` with its `use` directories)

| Step | Command |
|---|---|
| `format` | `gofmt -l .` |
| `vet` / `test` / `build` | `go vet ./...` / `go test ./...` / `go build ./...` |

`gofmt -l` exits 0 even when files need formatting, so `format` is judged by its
**output**: any listed file (outside `vendor/` and `testdata/`) is a FAIL, and the
files are named. A non-zero exit is a FAIL whose message is gofmt's stderr. `gofmt -w`
is never used. `GOTOOLCHAIN=local` is set so a missing Go version is reported, never
downloaded, and the `go` line of `go.mod` is required as a minimum.

**Rust** (`Cargo.toml`, `Cargo.lock`, workspaces)

| Step | Command |
|---|---|
| `check` | `cargo check --all-targets` |
| `test` | `cargo test` |
| `build` | `cargo build --release` |
| `format` | `cargo fmt --all -- --check` (needs rustfmt) |
| `lint` | `cargo clippy --all-targets -- -D warnings` (needs clippy) |

`--workspace` is added for a workspace, `--locked` whenever a `Cargo.lock` exists, and
`--offline` with `settings.offline`. `RUSTUP_AUTO_INSTALL=0` keeps rustup from
installing a toolchain. Without a `Cargo.lock`, cargo creates one and `doctor` says so.

### How a project is detected

Detection is read-only and deterministic. A manifest proves the ecosystem; it does not
prove the optional tools are in use or installed.

- **Strong evidence** identifies a project (`package.json`, a `.sln`/`.csproj`,
  `pom.xml`/`build.gradle`, `pyproject.toml` with `[project]`/`[tool.poetry]`/
  `[build-system]`, `setup.py`, `requirements*.txt`, `composer.json`, `go.mod`/`go.work`,
  `Cargo.toml` with `[package]`/`[workspace]`). **Weak evidence** (a `tox.ini`, a
  `pytest.ini`, a `pyproject.toml` with only tool tables) is reported as a candidate by
  `init` and `doctor` and never selected on its own.
- **Several ecosystems in one directory** are separate projects. **Ambiguity inside one
  ecosystem** (two solutions, Maven plus Gradle) blocks that project with the reason.
- `project.type` in `.local-ci.yml` always decides which adapter runs; detection only
  confirms it. A project that is not what its type says is BLOCKED with the reason.
- A check needs configuration or a declared dependency (otherwise it is unavailable and
  `UNSUPPORTED`) **and** its tool must be present when you run (otherwise `BLOCKED`).

### Dependency installation

No install step is ever added unless it is safe and necessary, and none rewrites a
manifest or lockfile.

| Ecosystem | `init` adds an install step when | It never |
|---|---|---|
| Node.js | a lockfile exists and `node_modules` is not already populated | runs `npm install` without a lockfile (BLOCKED) |
| .NET | always (`restore`) | |
| PHP | `composer.lock` exists and `vendor/` is absent | installs without a lockfile |
| Python | never | installs into a global interpreter |
| Java, Go, Rust | has no install step; the build tool resolves what it needs | `go mod tidy`, `cargo update` |

Checks that need installed dependencies are BLOCKED ("install dependencies first")
unless an install step runs earlier in the same project's pipeline, in which case it is
only a warning. `init` leaves such steps out and says why.

### Monorepos and several languages

A repository with several projects lists them under `projects`:

```yaml
version: 1
projects:
  - name: web
    type: react
    path: apps/web
    pipeline: [install, typecheck, lint, test, build]
  - name: api
    type: dotnet
    path: services/api
    pipeline: [restore, build, test]
  - name: ml
    type: python
    path: ml
    pipeline: [test, lint]
settings:
  failFast: false
```

- Step ids are qualified in reports and logs: `web.build`, `api.test`. A step shows as
  `web: Production Build`, and every report carries a per-project roll-up.
- A single `project:` with a `path:` points at one project below the root. The original
  `project:` + `pipeline:` form is unchanged and keeps bare step ids.
- `project` and `projects` are mutually exclusive; project names are letters, digits,
  `_` and `-`, and unique. Paths are relative to the configuration file, may not be
  absolute or contain `..`, and must stay inside the repository after symlinks are
  resolved.
- `local-ci-runner run --project web --project api` runs only those projects; an unknown
  name is an error.
- One project being BLOCKED never stops another project from running. `failFast` is
  pipeline-wide: after a failure, later steps that could have run are `SKIPPED`.

`init` and `doctor` find projects with workspace metadata first and a bounded scan
second. `package.json` `workspaces`, `pnpm-workspace.yaml`, `go.work`, Cargo
`[workspace]`, solution files, Maven `<modules>` and Gradle `include` say which
directories belong to a project that is already listed; those are reported as
*covered*, not listed again. The scan looks three levels deep by default and skips
`node_modules`, `.git`, `bin`, `obj`, `target`, `vendor`, `dist`, `build`, `.venv` and
similar. **Nothing is dropped silently:** covered members, weak candidates, directories
the depth limit did not reach, symbolic links (never followed), and workspace patterns
this version cannot expand (only literal paths, `*` and a trailing `**` are supported)
are all reported.

```bash
local-ci-runner init                          # one project: writes a minimal configuration
local-ci-runner init --dry-run                # print it, write nothing
local-ci-runner init --all                    # every detected project, as `projects:`
local-ci-runner init --path apps/web --type react
local-ci-runner init --scan-depth 5 --ignore legacy
```

`init` never overwrites an existing `.local-ci.yml` without `--force`; `--dry-run` is the
safe way to see what it would write. With more than one project it refuses to guess and
prints the exact command to choose each. It generates only checks that can run, and for
Go, Rust, .NET, Python, Java and PHP it also leaves out steps whose tool is not installed
on this machine, with the reason as a comment.

### Custom commands (`run:`)

When a check has no built-in form, give the exact command as an argument list:

```yaml
steps:
  contract-test:
    run: [node, scripts/contract-test.js, --strict]
    cwd: tools            # optional, relative to the project directory
    timeoutMs: 600000     # optional
```

- It is an argument list, never a shell string: nothing is split, quoted, expanded or
  globbed, so `$(...)`, `&&`, `*` and `%PATH%` reach the program as plain text.
- `run[0]` is either a bare program name (looked up on `PATH`, **absolute `PATH` entries
  only** — the current directory is never searched) or a path inside the project. A
  project path may not be absolute or contain `..`, and must still be inside the project
  after symlinks are resolved. `cwd` follows the same rules.
- There is no way to set environment variables from the file.
- A program that cannot be found, or a file that is not executable, is `BLOCKED` before
  anything runs. PowerShell scripts (`.ps1`) and, on Windows, `.sh` files cannot be
  started directly; run them through their interpreter (`[pwsh, -File, x.ps1]`,
  `[bash, x.sh]`).
- **Windows batch files (`.cmd`, `.bat`)** are started through `cmd.exe`, which
  re-parses arguments. Any argument containing `% ! ^ & | < > " ( )` or a line break is
  therefore rejected (the step is `BLOCKED`) rather than escaped. Call the underlying
  `.exe` or a `node` script instead. This applies to `npm`, `pnpm` and `yarn` too when
  you call them through `run:`.
- Timeouts, cancellation, process-tree cleanup, output capture and secret masking are
  the engine's, exactly as for every other step.

### Statuses

| Status | Meaning |
|---|---|
| `PASS` | The check ran and succeeded. |
| `FAIL` | The check ran and failed (non-zero exit, or its output judged it a failure, as `gofmt -l` does). |
| `TIMEOUT` | The check ran and exceeded its time limit (reported as `FAIL` with `timedOut: true`, classified separately). |
| `BLOCKED` | A requirement that is known to be missing prevented it from running: a tool, a JDK, installed dependencies, a lockfile, a required environment variable, a project that is not what its type says. Nothing ran. |
| `UNSUPPORTED` | local-ci-runner has no way to run this for this project: no such script, no configuration for the tool, an unknown step id. Nothing ran. |
| `SKIPPED` | Intentionally not run (`failFast`, or cancellation before it started). |
| `CANCELLED`, `ERROR` | Interrupted by the user; or an internal fault. |

Only `PASS` is success and only an all-`PASS` run exits 0. `BLOCKED`, `UNSUPPORTED`,
`SKIPPED`, `TIMEOUT`, `CANCELLED` and `ERROR` all exit non-zero, a pipeline made only of
unsupported steps fails, and none is ever reported as `PASS`. A diagnostic that says a
check *could not be performed* (`UNKNOWN`, for example when a sandbox forbids probing a
tool) never blocks and never counts as a pass: the step runs and its own result decides.

### Requirements and versions

- Node.js 20.5.0 or later runs the CLI.
- Every check needs its own tool on `PATH` (or the project's wrapper/virtual
  environment): `dotnet`, `python`, `java` plus `mvn`/`gradle` or a wrapper, `php` and
  `composer`, `go` and `gofmt`, `cargo` (with `rustfmt` and `clippy` for those steps).
- Minimums are enforced only where the project declares them: `go.mod`, `global.json`,
  `requires-python`, `composer.json` `require.php`, a Maven `release` of 9 or higher,
  `engines.node`. `dotnet format` needs SDK 6 or newer.

### Troubleshooting with `doctor`

`local-ci-runner doctor` lists, for each project, what it can run and from what
evidence, what it cannot and why, which tools are installed, and any project the
configuration does not cover. `preflight` is the same gate `run` applies.

| You see | Meaning and fix |
|---|---|
| `needs X, but X was not found on PATH` (`BLOCKED`) | Install it. Only that project's steps that need it are blocked. |
| `… was found, but "X --version" did not report a version` | The tool is installed but broken (for example a `dotnet` that cannot load). Repair it. |
| `needs pytest (python -m pytest), but it is not available` | Install pytest into the interpreter doctor names (the project's `.venv`, or the global one). |
| `node_modules is missing … no earlier install step` | Install dependencies, or add `install` before the step. |
| `requires java >= 21, but 17.0.12 is installed` | Switch JDK. Toolchains are never downloaded for you. |
| `more than one solution` / `both Maven … and Gradle` | Point the project at one (`project.path`), or define the steps with `run:`. |
| `mvnw is not executable` | `chmod +x mvnw`. |
| `UNSUPPORTED` for a step | The project has no script or configuration for it. Add one, or remove the step. |
| `Projects not in the configuration` | A project exists that `.local-ci.yml` never runs. Add it, or `init --all --dry-run`. |

### Local versus CI

This runs the checks on your machine, with your tools, before you push. It is not a CI
replacement and does not promise CI parity. It does not provide service containers,
secrets, matrix builds, caches, hosted-runner images or the network policy of your CI,
and it does not read GitHub Actions or Azure DevOps YAML. `npm audit`/`pnpm audit`,
Maven/Gradle wrappers and dependency restores use the network; `settings.offline` asks
cargo (`--offline`), Gradle (`--offline`) and Maven (`-o`) not to, and is ignored by the
other tools.

### Platform notes

- **Windows:** `.cmd`/`.bat` tools (`npm`, `pnpm`, `yarn`, `mvnw.cmd`, `gradlew.bat`,
  `vendor\bin\*.bat`) are supported; see the batch-file rules under `run:`. A project path
  containing `% ! ^ & | < > "` cannot use batch wrappers safely and is BLOCKED.
  Symbolic links and junctions are never followed during discovery.
- **macOS / Linux:** wrappers and `vendor/bin` tools must be executable.
- **npm and `allow-scripts`:** `npm test`, `npx` and `npm run` export your whole npm
  configuration to child processes as `npm_config_*` variables. With npm 11 and an
  `allow-scripts` setting, a child `npm ci` then fails with `EALLOWSCRIPTS`. That is
  npm's behaviour, and local-ci reports npm's message; unset the variable or run the
  CLI directly.

### Verification status

What has actually been exercised, as opposed to what the code intends:

| Ecosystem | Real tool exercised | Fake-tool / fixture tests |
|---|---|---|
| npm, pnpm, Bun | yes (Windows; scripts, `npm ci` from an empty lockfile) | yes |
| Yarn | not on the machine this was built on | yes |
| Python | yes: real interpreter and virtual environment, a missing `pytest` is `BLOCKED`. Real pytest/Ruff/mypy runs were not available. | yes |
| Java | the JDK probe and a missing `mvn`/`gradle` are real; no Maven/Gradle build was run | yes |
| .NET | a real but broken `dotnet` is `BLOCKED`; no working SDK was available | yes |
| Go, Rust, PHP/Composer | not installed on the machine this was built on | yes |

The `real-toolchains` job in `.github/workflows/verify-linux-process-tree.yml` installs
all of them and runs `tests/real` with `LOCAL_CI_REAL_TOOLCHAINS=required`, where a
missing tool is a failure instead of a skip. Until that job has passed, treat Go, Rust,
PHP, .NET builds, Maven, Gradle and Yarn as implemented and unit/integration tested
against fake tools, **not** as verified against the real tools. Linux and macOS paths
are covered by the existing CI matrix and by tests that stub the platform; they were not
run on the machine this was built on.

### Migrating from 0.2.x

- Existing single-project configurations work unchanged, and Angular produces the same
  commands as before.
- `project.type` still accepts any string. A type that is not in the table above behaves
  exactly as it did: only `steps:` entries run, every other step is `UNSUPPORTED`, and
  `validate`/`doctor` now print a warning saying so. Types that *are* in the table
  (`node`, `react`, `python`, …) now get their built-in checks, so a step you did not
  script, which used to be `UNSUPPORTED`, may now run (or be `BLOCKED`/`UNSUPPORTED` for
  a concrete reason). `steps:` entries still take precedence over built-ins.
- `init` refuses to write when several projects are found, instead of writing the Angular
  default. Use `--all`, `--path`/`--type`, or `--dry-run`.
- A tool that cannot be found now reads as missing (`BLOCKED`) on every platform; before,
  on Linux and macOS some probes read as unverified.

## Phase 4.5 status

Phase 4.5 adds **preflight, doctor and environment readiness**. The loop is now:

```
detect → preflight → run → diagnose → report → re-run
```

The product principle behind it: **DETECT → SOLVE/GUIDE → VERIFY**. A condition that
could not be verified is reported as unverified, never as a pass, and a blocked or
unsupported condition is never converted into `PASS`.

```
local-ci-runner preflight
      ↓
blocking condition?
      ├─ yes → report BLOCKED → do not execute the affected steps
      └─ no  → execute the pipeline
```

New commands:

- `local-ci-runner doctor` — diagnostic only. Audits the environment, the project and the
  configuration. It never executes a pipeline step, never installs anything and never
  modifies the project.
- `local-ci-runner preflight` — "can this configured pipeline reasonably run here?" Runs the
  same checks that gate `local-ci-runner run`, for a human.
- `local-ci-runner run` — now runs preflight first. Blocking conditions prevent the affected
  steps from executing and are reported as `BLOCKED`; warnings inform but never block.

Each run's report now also carries an **environment fingerprint** (OS, architecture,
Node, package manager, Git, Angular, browsers, CI/local marker) and the **preflight
result** that gated it, so a saved report is self-describing.

## Phase 4 status

Phase 4 delivers the **reporting layer**. Every run — successful, failed, timed
out, cancelled or unsupported — produces a complete, durable set of artifacts:

```
local-ci-runner run
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
- `local-ci-runner report <run-id>`, with safe run-id handling and readable errors

Azure DevOps, Docker, AI and other frameworks remain out of scope.

## Angular support

The core engine knows nothing about Angular. All Angular awareness lives in
`src/adapters/angular/`:

```
local-ci-runner run
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

For a package inside a monorepo with no lockfile of its own, the lockfile at the
workspace root is used. An ancestor counts as a workspace root only if it declares
one (`pnpm-workspace.yaml`, or `workspaces` in its `package.json`), and the search
never goes past the enclosing git repository.

With no lockfile anywhere, npm is used and the run reports that the choice was a
default. In that case the `install` step is **BLOCKED**: installing without a
lockfile would create one and could resolve different versions than CI, and a local
check must not quietly change the project it is checking. Commit a lockfile, or
remove `install` from the pipeline and install dependencies yourself.

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
local-ci-runner init
local-ci-runner validate
local-ci-runner doctor
local-ci-runner preflight
local-ci-runner run

local-ci-runner report <run-id>   # reopen a stored run
```

`doctor` diagnoses the machine and the project. `preflight` answers the one question
that decides whether `run` should start. `run` performs that same preflight itself
before executing anything.

The package can also be invoked after publishing with:

```bash
npx @dm-bishnoi/local-ci-runner init
npx @dm-bishnoi/local-ci-runner run
```

In an Angular project, `init` lists only the default steps (`install`, `typecheck`,
`test`, `coverage`, `lint`, `build`, `security`) that the project can actually run.
A step it cannot run yet, for example `lint` without a `"lint"` script or `install`
without a lockfile, is written as a comment in `pipeline` with the reason, and is
named in the output. Fix the cause and uncomment the line to add it; an unsupported
step that is listed is reported as `UNSUPPORTED`, never as passing. In any other
supported project `init` does the same for that ecosystem (see [Monorepos and several
languages](#monorepos-and-several-languages)); when nothing is detected it writes the
default pipeline and says so.

`init` also creates `.local-ci/.gitignore` (containing `*`), so stored reports stay
out of version control. Your own `.gitignore` is never edited. `run` creates the same
file if it is missing, and never overwrites one that exists.

When working on this repository itself, run the CLI with `node dist/cli/index.js` or
`npm run dev`. `npx --package=@dm-bishnoi/local-ci-runner@<this version>` from
*inside* the repository finds the repository's own package.json, installs nothing,
and reports `local-ci-runner` as not found. That is npm's behaviour, not a packaging
fault; run it from any other directory.

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

Optional per-step time limit in milliseconds, at most 24 hours. **When omitted, `run`
applies a default of 30 minutes (1800000 ms)**, so no step can hang indefinitely;
`validate` prints the effective timeout and whether it is the default. When the
limit is reached the whole process tree is terminated, the step fails with
`timedOut: true`, and the error states the limit, e.g. `Step timed out after 300s`.

A timed-out step keeps its evidence: the command line, and everything it printed
before the timeout, are in `report.json`, `report.html` and its log. The next step
starts only after the timed-out process tree has exited.

A timeout fails the step. It is never reported as a pass, and it is never silently
converted into a generic failure.

### settings.offline

Optional boolean. Asks tools that have an offline mode not to use the network: cargo
(`--offline`), Gradle (`--offline`) and Maven (`-o`). Tools without one ignore it; it
does not stop `npm ci`, `dotnet restore` or `composer install` from fetching packages
if you list those steps.

### steps

Run a project script as a pipeline step. This is how a non-Angular project (any
`project.type`) is checked, and how an Angular project adds a step the adapter does
not know (such as `e2e`) or points a built-in step at a different script.

```yaml
project:
  type: node
pipeline:
  - lint
  - test
  - e2e
steps:
  lint:
    script: lint
  test:
    script: test
  e2e:
    script: "test:e2e"
    timeoutMs: 600000      # optional; overrides settings.timeoutMs for this step
```

- Each key under `steps` must also be listed in `pipeline`.
- `script` is the name of a script in `package.json`. It runs as `npm run <script>`
  (`pnpm run` / `yarn run`, following your lockfile) with no shell string built by
  local-ci-runner. Names may use letters, digits and `: . _ / -`, and must start with a
  letter or digit.
- A `script` step accepts only `script` and `timeoutMs`. For any other command use
  `run:` (see [Custom commands](#custom-commands-run)). An unknown key is an error, as
  everywhere else in the file.
- A `steps` entry replaces the built-in implementation of the same id. Angular steps
  you do not script behave exactly as before.
- A script that is missing or empty in `package.json` reports `UNSUPPORTED` and exits
  non-zero; nothing is launched. `doctor` and `preflight` flag it first.
- Exit codes, timeouts, cancellation, process-tree cleanup, secret masking, logs and
  the JSON/HTML reports are the same as for every other step, and `failFast` applies.
- A `script` step can only choose among scripts that `package.json` already defines. A
  `run:` step starts the program you name, so treat `.local-ci.yml` like any other file
  that can execute code on your machine, and review changes to it.

### Unknown keys

Every section of `.local-ci.yml` is strict: an unrecognised key is an error that names
the key and where it is (for example `settings: Unrecognized key: "timeoutms"`). A
misspelled setting therefore fails `validate` and `run` instead of being silently
ignored.

## Pipeline execution lifecycle

Each step moves through the lifecycle and ends in exactly one terminal status. See
[Step statuses](#step-statuses) for what each one means and whether it gets a log
file.

An `UNSUPPORTED` step always makes the pipeline non-successful. Missing functionality is
never reported as a pass.

## Cancellation

Pressing Ctrl+C (SIGINT) during `local-ci-runner run`:

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
local-ci-runner doctor
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
| `UNSUPPORTED` | local-ci-runner cannot perform this capability. |
| `ERROR` | The check itself failed; the answer is genuinely unknown. |
| `UNKNOWN` | Deliberately unverified — reported, never promoted to `PASS`. |

A requirement that could not actually be verified is reported as `UNKNOWN` or
`WARNING`, never as satisfied.

## Preflight

```bash
local-ci-runner preflight
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

local-ci-runner itself requires Node.js 20.5.0 or later (the minimum its process
runner, execa, supports). CI runs the full suite on Windows, macOS and Linux with Node
20.x, 22.x and 24.x, and smoke-tests the packed CLI on exactly Node 20.5.0.

For the project being checked, `engines.node` and `.nvmrc` are checked with a
deliberately small range checker (no semver dependency). A range is alternatives
separated by `||`; each alternative is comparators that must all hold, separated by
whitespace or commas. Supported comparators: `>=`, `>`, `<=`, `<`, `=`, exact and
partial versions (`20.11.0`, `20`), x-ranges (`20.x`, `*`), caret (`^18.19.0`) and tilde
(`~18.19.0`). Whitespace after an operator is fine: `>= 18` means `>=18`.

A range the checker cannot evaluate with confidence (dist-tags such as `lts/*`,
hyphen ranges, text) is reported as `UNKNOWN` with guidance to verify manually —
local-ci does not claim compatibility it could not check, and an unreadable part of a
range is never treated as satisfied.

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

- Not every ecosystem has been verified against its real tool; see [Verification
  status](#verification-status). Checks that need a tool, a dependency or a configuration
  the project does not have are `BLOCKED` or `UNSUPPORTED`, never skipped silently.
- `doctor`, `preflight` and `run` check the Node.js version of the repository root for
  the original single-project path, and `engines.node` per project for `projects`; they
  do not read `.nvmrc` per project.
- `settings.offline` is honoured by cargo, Gradle and Maven only.
- Workspace member patterns are literal paths, `*` and a trailing `**`; anything else is
  reported and not expanded.
- `gofmt -l` is run on the module directories only; `go.work` entries outside the project
  make the Go steps unavailable.
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
local-ci-runner report 20261008-123456-abcd1234
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
| `UNSUPPORTED` | local-ci-runner cannot execute this capability. Nothing ran. | no |
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
  are replaced with `***`. Names match on words such as `TOKEN`, `SECRET`, `PASSWORD`,
  `AUTH`, `CONNECTION_STRING` and `WEBHOOK`, and on whole name segments `PAT`, `KEY`,
  `PWD`, `PASS` and `DSN` (so `GH_PAT`, `AZURE_DEVOPS_EXT_PAT` and `STRIPE_KEY` are
  masked while `PATH` and `KEYBOARD_LAYOUT` are not).
- Credentials with a recognisable *format* are masked even when no environment
  variable reveals them: `Authorization:` header values, `Bearer` tokens, JWTs, GitHub
  (`ghp_…`, `github_pat_…`) and npm (`npm_…`) tokens, `.npmrc` `_authToken=` values,
  Slack tokens, AWS access key ids, and `Password=` / `AccountKey=` values in
  connection strings.
- Reports live under `.local-ci/`, which ignores itself through `.local-ci/.gitignore`.
  Masking is a safety net, not a guarantee — a secret printed in an unrecognised form
  is not masked — so stored reports are kept out of version control as well.
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

`local-ci-runner doctor` distinguishes a tool that is not installed from one that could not be
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
- `src/diagnostics/doctor.ts`, `preflight.ts` — the check sets behind `local-ci-runner doctor`
  and `local-ci-runner preflight`, and the gate `run` consults before executing.
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
3a. Node.js, .NET, Python, Java, PHP, Go and Rust adapters, monorepo `projects`, `run:` steps — implemented; real-toolchain verification pending for the tools listed under [Verification status](#verification-status)
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