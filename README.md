# Local CI Runner

**Run your CI checks locally before you push.**

[![npm version](https://img.shields.io/npm/v/@dm-bishnoi/local-ci-runner)](https://www.npmjs.com/package/@dm-bishnoi/local-ci-runner)
[![license](https://img.shields.io/npm/l/@dm-bishnoi/local-ci-runner)](LICENSE)
[![CI](https://github.com/dm-bishnoi/local-ci/actions/workflows/verify-linux-process-tree.yml/badge.svg?branch=main)](https://github.com/dm-bishnoi/local-ci/actions/workflows/verify-linux-process-tree.yml)
[![node](https://img.shields.io/node/v/@dm-bishnoi/local-ci-runner)](package.json)

Local CI Runner is a command-line tool that runs a project's checks (install, type check,
lint, format, test, build and others) on your own machine, with your own toolchains,
before you push. It works out which checks the project can actually run, runs them
without a shell, and writes console, JSON and HTML reports. A check that could not run is
reported as `BLOCKED` or `UNSUPPORTED`, never as a pass.

```bash
npx @dm-bishnoi/local-ci-runner init
npx @dm-bishnoi/local-ci-runner run
```

> [!IMPORTANT]
> **Released vs. `main`.** The npm release **0.2.0** ships the Angular adapter,
> `package.json` script steps (`steps.<id>.script`), `doctor`, `preflight` and the reports.
> Everything else in this README is merged on `main` but **not yet released**:
> multi-language support (.NET, Python, Java, PHP, Go, Rust, the generic Node.js family),
> `projects:`, `project.path`, `steps.<id>.run`, `settings.offline`,
> `init --dry-run/--type/--path/--all/--scan-depth/--ignore` and `run --project`.
> These are marked *(unreleased)* below. To use them now, [install from source](#install-from-source).

## Contents

- [Why Local CI Runner?](#why-local-ci-runner)
- [Quick start](#quick-start)
- [Supported ecosystems](#supported-ecosystems)
- [Configuration](#configuration)
- [CLI reference](#cli-reference)
- [Reports and diagnostics](#reports-and-diagnostics)
- [Security and execution model](#security-and-execution-model)
- [Requirements and troubleshooting](#requirements-and-troubleshooting)
- [Development and contributing](#development-and-contributing)
- [Roadmap and limitations](#roadmap-and-limitations)
- [License](#license)

## Why Local CI Runner?

- **Catch failures before you push.** A failing build or test shows up on your machine,
  not after a CI round trip.
- **Runs on your machine.** It uses the tools you already have installed and never
  installs or switches a toolchain for you. Build-tool wrappers such as `mvnw` may still
  download their own pinned distribution.
- **Tells you what it could not check.** Every step ends with exactly one status, such as
  `PASS`, `FAIL`, `BLOCKED` (a known requirement is missing), `UNSUPPORTED` (there is
  nothing to run) or `SKIPPED` (see [Step statuses](#step-statuses)). Only an all-`PASS`
  run exits 0.
- **Reports you can act on.** Each run writes a console summary, `report.json`,
  `summary.json`, a self-contained `report.html` and one log file per step that ran. Each
  failure or block comes with its reason.
- **An honest scope.** Running locally does not reproduce a remote CI environment. Local
  CI Runner does not provide service containers, CI secrets, matrix builds, caches,
  hosted-runner images or your CI's network policy, and it does not read GitHub Actions
  or Azure DevOps YAML. Use it to find problems early, not to replace CI.

## Quick start

### Install

```bash
npm install --save-dev @dm-bishnoi/local-ci-runner   # per project
npx @dm-bishnoi/local-ci-runner --help               # or run without installing
```

The package is `@dm-bishnoi/local-ci-runner`, and the command it installs is
`local-ci-runner`. It needs Node.js 20.5.0 or later.

> [!NOTE]
> **The npm package is 0.2.0.** It detects Angular projects only; any other project runs
> just its `steps.<id>.script` entries, and in a non-Angular project `init` writes the
> Angular default pipeline. Its `init` accepts only `--force`, and `run` takes no
> options. Everything marked *(unreleased)* in this README, including
> `init --dry-run/--type/--path/--all`, `run --project`, `projects:` and `run:`, needs a
> [build from source](#install-from-source).

#### Install from source

To use the unreleased features on `main`, build a package from a clone and install it
into your project:

```bash
git clone https://github.com/dm-bishnoi/local-ci.git
cd local-ci
npm ci
npm pack                                   # builds dist/ and writes dm-bishnoi-local-ci-runner-<version>.tgz
cd /path/to/your/project
npm install --save-dev /path/to/local-ci/dm-bishnoi-local-ci-runner-<version>.tgz
```

You can also run the built CLI directly: `node /path/to/local-ci/dist/cli/index.js <command>`.

### First run

Run every command from the directory that holds (or will hold) `.local-ci.yml`. The
configuration is read from the current directory only; it is not searched for in parent
directories.

```bash
cd /path/to/your/project
local-ci-runner init        # detect the project and write .local-ci.yml
local-ci-runner validate    # check the file against the schema
local-ci-runner doctor      # what can run here, what cannot, and why
local-ci-runner run         # preflight, then run the pipeline
local-ci-runner report      # list stored runs; add a run id to show one
```

If you installed the package into the project (`npm install --save-dev`), prefix each
command with `npx`. For a Node.js project with `test`, `lint` and `build` scripts and a
`package-lock.json`, `init` *(unreleased: generic Node.js detection)* writes:

```yaml
version: 1

project:
  type: "node"

pipeline:
  - install
  - test
  - lint
  - build
  # Not added (see the reason after each step). Fix the cause, then add it.
  # - typecheck  # No "typecheck" script in package.json, and no inferable type checker (needs "typescript" or "vue-tsc" declared and a tsconfig.json).
  # - coverage  # Coverage cannot be determined safely: no "coverage" script, and no known coverage provider (karma-coverage, nyc, jest, c8 or @vitest/coverage-*) was found in dependencies.
  # - format  # No "format:check" script in package.json, and no Prettier with a configuration was found.
  # - security  # An audit contacts the package registry. Add "security" if you want it.

settings:
  failFast: false
  timeoutMs: 300000
```

`run` then prints one line per step and the overall result:

```text
✓ Dependencies      PASS      2.8s  exit 0
✓ Unit Tests        PASS      2.6s  exit 0
✓ Lint              PASS      3.4s  exit 0
✓ Production Build  PASS      2.7s  exit 0

Result:          PASS
Run ID:          20261015-120540-a16ce8a4
```

`init` only lists steps the project can run now. Every other default step is left as a
comment with the reason. `init` also creates `.local-ci/.gitignore` (containing `*`), so
stored reports stay out of version control. It never edits your own `.gitignore` and
never overwrites an existing `.local-ci.yml` unless you pass `--force`.

## Supported ecosystems

*(Unreleased, except Angular and `package.json` script steps, which are in 0.2.0.)*

| Ecosystem | `project.type` | Implemented checks (step ids) |
|---|---|---|
| Node.js: JavaScript, TypeScript, React, Vue, Angular | `node`, `javascript`, `typescript`, `react`, `vue`, `angular` | `install`, `typecheck`, `test`, `coverage`, `lint`, `format`, `build`, `security` |
| .NET / C# | `dotnet`, `csharp` | `restore`, `build`, `test`, `format` |
| Python | `python` | `install` (explicit only), `test`, `lint`, `format`, `typecheck` |
| Java (Maven, Gradle) | `maven`, `gradle`, `java` | `compile`, `test`, `verify`, `build` |
| PHP (Composer) | `php`, `composer` | `install`, `test`, `analyse`, `format` |
| Go | `go` | `format`, `vet`, `test`, `build` |
| Rust (Cargo) | `rust`, `cargo` | `check`, `test`, `build`, `format`, `lint` |

`project.type` is case-insensitive. JavaScript, TypeScript, React, Vue and Angular all
run the same Node.js checks; the type is a label, and no framework is assumed to use a
particular test runner. A type that is not in the table runs only your `steps:` entries,
and `validate`/`doctor` warn about it.

A check is available only when the project shows evidence for it (a script, a
configuration file or a declared dependency). Otherwise it is `UNSUPPORTED`. Its tool
must also be installed when you run, otherwise the step is `BLOCKED`.

### Verification status

What has been exercised against real tools, and what has only been tested against fake
tools and fixtures. The real-tool evidence is the `Real toolchains` job in
[`verify-linux-process-tree.yml`](.github/workflows/verify-linux-process-tree.yml), which
runs on `ubuntu-latest`, `windows-latest` and `macos-latest`. It runs `tests/real` and fails,
rather than skips, when a tool is missing; a skip outside a short list of expected ones
(`scripts/check-skips.mjs`) also fails the job. The expected skips are the 3 tests for tools
that are *absent or broken* (a `dotnet` that cannot run, and a Maven or Gradle project with no
`mvn`/`gradle`), which cannot occur on a runner where the tools are installed. The same job
then installs the **packed tarball** into an empty directory and runs `init`, `doctor` and
`run` (and a deliberately broken `run`) for a Node, Python, Go, Rust, .NET and PHP project
(`scripts/smoke-packed.mjs`).

| Ecosystem | Real tool in CI (Ubuntu, Windows, macOS) | Tested only with fake tools / fixtures |
|---|---|---|
| Node.js | `npm ci` from a lockfile and `npm run` scripts; script runs through pnpm, Yarn and Bun | inferred `tsc`/`vue-tsc`/`eslint`/`prettier`/`vitest`/`jest`, `coverage`, `security` (`npm audit`/`pnpm audit`), real Angular/React/Vue builds |
| .NET (SDK 8) | `restore` and `build` of a console project | `test`, `format`, solution ambiguity |
| Python (3.12) | virtual-environment selection; a missing tool is `BLOCKED`; pytest pass and fail; `ruff check` and `ruff format --check` | `typecheck` (mypy), `install` (pip, uv, poetry) |
| Java: Maven (JDK 17) | `compile`, `test`, `verify` and `build` of a JUnit 4 project; a failing test fails `test` and `verify`; code that does not compile fails `compile` | `mvnw` wrapper, `settings.offline` |
| Java: Gradle (JDK 17) | the same four steps and failure cases | `gradlew` wrapper, `settings.offline`, Kotlin DSL, multi-module builds |
| PHP (8.3) | `composer install` from a lockfile, then a composer `test` script | PHPUnit fallback, PHPStan, php-cs-fixer, phpcs |
| Go (1.22) | `format`, `vet`, `test`, `build`; unformatted code is a `FAIL` and is not rewritten | `go.work` workspaces |
| Rust (stable) | `check`, `test`, `build` with `--offline --locked`; `cargo fmt --check` | `lint` (clippy), workspaces |

The Maven and Gradle builds download their plugins and JUnit from Maven Central, so they run
only where `LOCAL_CI_REAL_TOOLCHAINS` is set (the CI job, or a developer opting in). They use
the Maven and Gradle that are installed on the CI runner image, not pinned versions.

**Known gaps:** mypy, clippy, `dotnet test`, `dotnet format`, the PHP analysers and real
front-end framework builds (Angular, React, Vue) have not been run against the real tools.
`coverage` and `security` exist only for Node.js. Each real fixture is small, and each tool
is tested at one version. Treat everything in the right-hand column as implemented and tested
against fakes, not as production-verified.

### What each check runs

Each command is an executable plus an argument list; no shell is involved. Expand an
ecosystem for details.

<details>
<summary><strong>Node.js</strong> (npm, pnpm, Yarn classic/Berry, Bun, chosen from the lockfile)</summary>

| Step | Command | Needs |
|---|---|---|
| `install` | `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile` (Berry: `--immutable`) / `bun install --frozen-lockfile` | a lockfile; without one the step is `BLOCKED` because it would create one |
| `typecheck`, `test`, `lint`, `build` | `<manager> run <script>` | the script in `package.json`. An explicit script always wins. |
| `coverage` | `<manager> run coverage`, else `<manager> run test --coverage` | a `coverage` script, or a `test` script plus `nyc`, `c8`, `jest`, `karma-coverage` or `@vitest/coverage-*` |
| `format` | `<manager> run format:check` | a `format:check` script. A plain `format` script is never run, because it may rewrite files. |
| `security` | `npm audit --json` / `pnpm audit --json` | npm or pnpm (`UNSUPPORTED` for Yarn and Bun). Contacts the registry. |

Without a script, a tool is inferred only when it is declared in `package.json` **and**
its configuration exists: `tsc --noEmit -p tsconfig.json`, `vue-tsc --noEmit`,
`eslint .`, `prettier --check .`, `vitest run` or `jest --ci` (exactly one declared).
Angular projects get only `ng build` as an inferred fallback. Inferred tools run through
`npx --no-install`, `pnpm exec`, `yarn exec` or `bun x --no-install`, so nothing is
fetched from a registry.

In a monorepo package with no lockfile of its own, the workspace root's lockfile is used.
A root counts only if it declares workspaces (`pnpm-workspace.yaml` or `workspaces` in
`package.json`), and the search never leaves the enclosing git repository. The
package manager is never installed, switched or replaced.
</details>

<details>
<summary><strong>.NET</strong> (<code>.sln</code>, <code>.slnx</code>, or one SDK-style project)</summary>

| Step | Command |
|---|---|
| `restore` | `dotnet restore ./<target>` (`--locked-mode` when `packages.lock.json` exists) |
| `build` | `dotnet build ./<target> --no-restore -c Release` |
| `test` | `dotnet test ./<target> --no-restore -c Release`, only when a project references `Microsoft.NET.Test.Sdk` or sets `IsTestProject` |
| `format` | `dotnet format ./<target> --verify-no-changes --no-restore` (SDK 6+; `init` adds it only if `.editorconfig` exists) |

Several solutions, or several projects without a solution, in one directory are
`BLOCKED` as ambiguous. Point `project.path` at one. A `global.json` SDK version is
enforced as a minimum. Telemetry and the first-run banner are turned off.
</details>

<details>
<summary><strong>Python</strong></summary>

| Step | Command | Evidence required |
|---|---|---|
| `test` | `python -m pytest` | `pytest.ini`, `[tool.pytest.ini_options]`, `[tool:pytest]`, `conftest.py`, or a declared dependency |
| `lint` | `python -m ruff check .` | `ruff.toml`, `[tool.ruff]`, or a declared dependency |
| `format` | `python -m ruff format --check .` | same as `lint` |
| `typecheck` | `python -m mypy [<package>]` | mypy configuration or dependency, plus a `files` setting or exactly one package |
| `install` | `<venv python> -m pip install -r requirements.txt`, `uv sync --locked`, or `poetry install --no-interaction --sync` | an existing `.venv`/`venv` with `requirements.txt`, or `uv.lock`/`poetry.lock` with that tool |

Each tool must also import in the chosen interpreter: the project's `.venv` or `venv`,
otherwise `python3`, then `python` (on Windows: `python`, then `py -3`). `install` is never generated by `init`
and never targets a global interpreter. `requires-python = ">=X.Y"` is enforced as a
minimum.
</details>

<details>
<summary><strong>Java</strong> (Maven or Gradle; wrapper first)</summary>

| Step | Maven | Gradle |
|---|---|---|
| `compile` | `mvn -B compile` | `gradle --console=plain --no-daemon classes` |
| `test` | `mvn -B test` | `gradle … test` |
| `verify` | `mvn -B verify` | `gradle … check` |
| `build` | `mvn -B package -DskipTests` | `gradle … assemble` |

`mvnw`/`gradlew` (`.cmd`/`.bat` on Windows) are preferred when present, and they download
their pinned distribution on first use. A JDK is always required. A declared
`release`/`java.version` of 9 or higher becomes a minimum. `pom.xml` together with
`build.gradle` is `BLOCKED` as ambiguous, and so is a wrapper that is not executable or
has no properties file.
</details>

<details>
<summary><strong>PHP</strong> (Composer)</summary>

| Step | Command | Evidence required |
|---|---|---|
| `install` | `composer install --no-interaction --no-progress` | `composer.lock` (otherwise `UNSUPPORTED`) |
| `test` | `composer run-script test`, else `vendor/bin/phpunit --do-not-cache-result` | a `test` script, or `phpunit.xml(.dist)` plus PHPUnit |
| `analyse` | `vendor/bin/phpstan analyse --no-progress` | `phpstan.neon(.dist)` plus PHPStan |
| `format` | `vendor/bin/php-cs-fixer fix --dry-run --diff` or `vendor/bin/phpcs` | the tool's configuration plus the tool |

In a PHP project, `steps.<id>.script` names a Composer script. A `require.php` with a
single lower bound is enforced as a minimum.
</details>

<details>
<summary><strong>Go</strong> (<code>go.mod</code>, or <code>go.work</code>)</summary>

| Step | Command |
|---|---|
| `format` | `gofmt -l .` |
| `vet` / `test` / `build` | `go vet ./...` / `go test ./...` / `go build ./...` |

`gofmt -l` exits 0 even when files need formatting, so `format` is judged by its output.
Any file it lists (outside `vendor/` and `testdata/`) makes the step `FAIL`, and the
files are named. `gofmt -w` is never used. `GOTOOLCHAIN=local` stops Go from downloading
a toolchain, and the `go` line of `go.mod` is enforced as a minimum.
</details>

<details>
<summary><strong>Rust</strong> (Cargo)</summary>

| Step | Command |
|---|---|
| `check` | `cargo check --all-targets` |
| `test` | `cargo test` |
| `build` | `cargo build --release` |
| `format` | `cargo fmt --all -- --check` (needs rustfmt) |
| `lint` | `cargo clippy --all-targets -- -D warnings` (needs clippy) |

`--workspace` is added for a workspace, `--locked` when `Cargo.lock` exists, and
`--offline` with `settings.offline`. `RUSTUP_AUTO_INSTALL=0` stops rustup from
installing a toolchain.
</details>

### Detection and dependency installation

Detection is read-only. A manifest such as `package.json`, a `.sln`/`.csproj`,
`pom.xml`/`build.gradle`, `pyproject.toml` with `[project]`, `composer.json`, `go.mod` or
`Cargo.toml` identifies a project. Weaker hints, such as a `tox.ini` alone, are reported
as candidates and never selected on their own. `project.type` in `.local-ci.yml` always
decides which adapter runs. If the project on disk is not what the type says, its steps
are `BLOCKED`.

No install step rewrites a manifest or lockfile, and none is added unless it is safe:

| Ecosystem | `init` adds an install step when | Never |
|---|---|---|
| Node.js | a lockfile exists and `node_modules` is not populated | installs without a lockfile (`BLOCKED`) |
| .NET | always (`restore`) | |
| PHP | `composer.lock` exists and `vendor/` does not | installs without a lockfile |
| Python | never | installs into a global interpreter |
| Java, Go, Rust | no install step; the build tool resolves what it needs | runs `go mod tidy` or `cargo update` |

A check that needs installed dependencies is `BLOCKED` ("install dependencies first")
unless an install step runs earlier in the same project's pipeline.

## Configuration

`.local-ci.yml` sits in the directory you run the CLI from. Every section is strict: an
unknown or misspelled key (`timeoutms`, `failfast`) is an error that names the key, so a
typo cannot silently change behaviour.

### Minimal configuration

This is [`templates/local-ci.yml`](templates/local-ci.yml), the Angular default that 0.2.0
also uses:

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

### Options

| Key | Meaning |
|---|---|
| `version` | Always `1`. |
| `project.type` | Which adapter runs (see [Supported ecosystems](#supported-ecosystems)). Any string is accepted; an unknown type runs only `steps:` entries. |
| `project.path` *(unreleased)* | Project directory relative to the configuration file. |
| `pipeline` | Step ids, run in order. Required with `project`. |
| `projects` *(unreleased)* | A list of projects, each with `name`, `type`, optional `path`, `pipeline` and optional `steps`. Cannot be combined with `project`, or with top-level `pipeline`/`steps`. |
| `steps.<id>.script` | Run a `package.json` script (a Composer script in PHP projects) as step `<id>`. |
| `steps.<id>.run` *(unreleased)* | Run a command given as an argument list. See [Custom commands](#custom-commands-run). |
| `steps.<id>.cwd` *(unreleased)* | Working directory for a `run:` step, relative to the project. |
| `steps.<id>.timeoutMs` | Per-step time limit that overrides `settings.timeoutMs`. |
| `settings.failFast` | `false` (default): every step runs. `true`: after the first step that does not pass (`FAIL`, `UNSUPPORTED`, `BLOCKED`, …), later steps that could run are `SKIPPED`. |
| `settings.timeoutMs` | Per-step limit in ms, at most 24 hours. **Default: 30 minutes.** A timed-out step's whole process tree is terminated and the step fails with `timedOut: true`. |
| `settings.offline` *(unreleased)* | Asks cargo (`--offline`), Gradle (`--offline`) and Maven (`-o`) not to use the network. Other tools ignore it. |
| `environment.variables.required` | Variable names that must be set. Only presence is checked; values are never read or stored, and `.env` files are never loaded. A missing variable is `BLOCKED`. |

Each key under `steps` must also appear in the pipeline, and a `steps` entry replaces
the built-in check with the same id.

### Script steps

Run any `package.json` script as a step. This works for every `project.type`, including
types that have no built-in adapter:

```yaml
version: 1

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
    timeoutMs: 600000

environment:
  variables:
    required:
      - API_URL
```

Because every step is scripted, this also works with 0.2.0. Install dependencies first:
0.2.0 blocks these steps when `node_modules` is missing or empty and the pipeline has no
`install` step. On `main`, `lint` and `test` would also work without `steps:` entries,
through the built-in Node.js checks.

The script runs as `npm run <script>` (`pnpm run` / `yarn run`, following the lockfile).
Its name is passed as one argument and must use only letters, digits and `: . _ / -`.
A script that is missing from `package.json` makes the step `UNSUPPORTED`; nothing is
launched.

### Monorepos and multiple languages

*(Unreleased.)* List each project with its own directory and pipeline. Paths are relative to the
configuration file. They may not be absolute or contain `..`, and must stay inside the
repository after symbolic links are resolved.

```yaml
version: 1

projects:
  - name: web
    type: node
    path: apps/web
    pipeline: [install, test, build, contract-test]
    steps:
      contract-test:
        run: [node, scripts/contract-test.js, --strict]
  - name: ml
    type: python
    path: ml
    pipeline: [test]
  - name: gateway
    type: go
    path: services/gateway
    pipeline: [format, vet, test, build]

settings:
  failFast: false
  timeoutMs: 600000
```

Every step id above is a built-in check of that project's ecosystem, except
`contract-test`, which is defined by `run:`. No step is meant to be `BLOCKED` or
`UNSUPPORTED`, but each project needs its own setup:

- **`web`** (`node`): `apps/web/package.json` with `test` and `build` scripts, a lockfile
  (`install` is `BLOCKED` without one), and `apps/web/scripts/contract-test.js`. The `run:`
  path is resolved from the project directory.
- **`ml`** (`python`): pytest configuration (for example `[tool.pytest.ini_options]` in
  `ml/pyproject.toml`), and pytest installed in `ml/.venv` or the interpreter on `PATH`.
  Without the configuration, `test` is `UNSUPPORTED`. Without pytest installed, it is
  `BLOCKED`.
- **`gateway`** (`go`): `services/gateway/go.mod`, with `go` and `gofmt` on `PATH`.
  Without them, all four steps are `BLOCKED`, and only this project is affected.

Running `local-ci-runner doctor` shows which of these is missing.

- Run it from the repository root (where `.local-ci.yml` is). Steps run inside each
  project's `path`.
- Step ids are qualified in reports and logs (`web.build`), steps are shown as
  `web: Production Build`. The console, `report.json` and `report.html` include a
  per-project roll-up (`summary.json` does not).
- `local-ci-runner run --project web` runs only that project. Repeat `--project` to run
  several; an unknown name is an error.
- A project that is `BLOCKED` (for example, Go is not installed) never stops another
  project from running.
- Project names use letters, digits, `_` and `-`, and must be unique.

[`templates/monorepo.local-ci.yml`](templates/monorepo.local-ci.yml) has a larger example
covering all seven ecosystems. `init --all` generates a `projects:` list from what is on
disk (see [`init`](#init)).

### Custom commands (`run:`)

*(Unreleased.)* When a check has no built-in form, give the exact command as an argument list:

```yaml
version: 1

project:
  type: node

pipeline:
  - contract-test

steps:
  contract-test:
    run: [node, scripts/contract-test.js, --strict]
    cwd: tools
    timeoutMs: 600000
```

- **An argument list, never a shell string.** Nothing is split, quoted, expanded or
  globbed, so `$(...)`, `&&`, `*` and `%PATH%` reach the program as literal text.
- `run[0]` is either a bare program name, looked up on `PATH` using only absolute `PATH`
  entries (the current directory is never searched), or a path inside the project. Paths
  in `run[0]` and `cwd` may not be absolute or contain `..`, and must still be inside the
  project after symbolic links are resolved.
- Environment variables cannot be set from the file.
- A program that cannot be found, or a file that is not executable, is `BLOCKED` before
  anything runs. Run `.ps1` scripts, and `.sh` scripts on Windows, through their
  interpreter: `[pwsh, -File, x.ps1]`, `[bash, x.sh]`.
- **Windows `.cmd`/`.bat` files** are started through `cmd.exe`, which re-parses
  arguments. An argument containing `% ! ^ & | < > " ( )` or a line break is rejected
  (the step is `BLOCKED`), not escaped. This also applies to `npm`, `pnpm` and `yarn`
  when you call them through `run:`. Call the underlying `.exe` or a `node` script instead.

## CLI reference

```text
local-ci-runner <command> [options]
```

| Command | Options | What it does |
|---|---|---|
| `init` | `--force`, `--dry-run`, `--type <type>`, `--path <dir>`, `--all`, `--scan-depth <n>`, `--ignore <name>` | Detect the project and write `.local-ci.yml`. In 0.2.0 only `--force` exists. |
| `validate` | | Check `.local-ci.yml` against the schema and print the effective step timeout. |
| `doctor` | | Diagnose the environment, the projects and the configuration. Never runs a step or installs anything. |
| `preflight` | | Ask whether the configured pipeline can run here. This is the same gate `run` applies first. |
| `run` | `-p, --project <name>` (repeatable) | Run preflight, then the pipeline, then write the reports. 0.2.0 has no options. |
| `report` | `[run-id]` | Print a stored run's console report. Without an id, print usage and the stored run ids, and exit 1. |
| `version` | (also `-V`, `--version`) | Print the version. |

### `init`

```bash
local-ci-runner init                            # one project: write .local-ci.yml
local-ci-runner init --dry-run                  # print it, write nothing
local-ci-runner init --all                      # every detected project, as "projects:"
local-ci-runner init --path apps/web --type react
local-ci-runner init --scan-depth 5 --ignore legacy
local-ci-runner init --force                    # replace an existing file
```

- When several projects are found, `init` writes nothing. It lists each project with the
  exact `init --path … --type …` command to choose it, and suggests `--all`.
- `--all` also writes nothing if any detected project has no runnable check, and prints
  the reason for each step.
- Discovery uses workspace metadata first (`workspaces`, `pnpm-workspace.yaml`,
  `go.work`, Cargo `[workspace]`, solutions, Maven `<modules>`, Gradle `include`), then
  scans 3 levels deep by default (`--scan-depth` 0-8). It skips `node_modules`, `.git`,
  `bin`, `obj`, `target`, `vendor`, `dist`, `build`, `.venv` and similar, and never
  follows symbolic links. Members, weak candidates, directories beyond the depth limit,
  and workspace patterns it cannot expand are reported, not silently dropped.
- `--type` within the JavaScript family is only a label. For another ecosystem it must
  match what is on disk (`--type python` with no Python project is an error).

### `run`

```bash
local-ci-runner run                             # whole pipeline
local-ci-runner run --project web --project api # only these projects
```

Press Ctrl+C to cancel. The running step's whole process tree is terminated and the step
is marked `CANCELLED`, the remaining steps are `SKIPPED`, reports are still written, and
the command exits non-zero.

### `report`

```bash
local-ci-runner report                          # usage + stored run ids (exits 1)
local-ci-runner report 20261015-120540-a16ce8a4 # print that run's report
```

Without a run id, `report` prints its usage line and the 10 most recent stored run ids
(or "No stored reports were found") to stderr, and exits **1**. With a valid id it prints
the stored report and exits **0**, even when that run failed: the stored run's own result
is in the report, not in this command's exit code. Run ids are validated before they reach
the filesystem: a value like `../bad`, or an id with no stored report, is rejected with one
readable sentence and the list of real runs, and exits 1.

### Exit codes

Every non-zero exit code is `1`.

| Command | Exits `0` when | Exits `1` when |
|---|---|---|
| `run` | every step is `PASS` and all reports were written | any step is `FAIL`, `TIMEOUT`, `BLOCKED`, `UNSUPPORTED`, `CANCELLED` or `ERROR`; a report artifact could not be written; the configuration is missing or invalid; `--project` names an unknown project |
| `doctor`, `preflight` | the verdict is `PASS` or `WARNING` | the verdict is `BLOCKED` or `ERROR` |
| `validate` | the configuration is valid | it is missing, unreadable or invalid |
| `init` | the file was written (or printed with `--dry-run`) | it refused to write (existing file without `--force`, several projects, nothing runnable) or an option was invalid |
| `report` | a stored report was printed | no run id, an invalid id, or no readable report for that id |

`doctor` and `preflight` treat `UNKNOWN` and `UNSUPPORTED` checks as a `WARNING`, so they
can exit 0 for a pipeline that `run` will then fail with `UNSUPPORTED` steps. Read their
output, not just the exit code.

## Reports and diagnostics

### Where reports are written

Every `run`, including failed, blocked, timed-out and cancelled runs, writes a directory
under the folder you ran it from:

```text
.local-ci/
  .gitignore                 # "*": reports never get committed
  reports/
    20261015-120655-499b6d68/
      report.json            # complete record
      summary.json           # small, flat digest
      report.html            # self-contained dashboard, opens from disk
      logs/
        web.install.log      # one log per step that actually ran
        web.build.log
```

A run id is `YYYYMMDD-HHmmss-<8 hex>`, and `run` prints the id and every artifact path at
the end. A single-project run names its logs by step id (`build.log`). A `projects:` run
qualifies them (`web.build.log`).

- **Console:** one line per step, a reason for every failed or blocked step, the
  preflight result, and coverage.
- **`report.json`:** run id, project, package manager, status and outcome, timing, exit
  code, coverage, per-status counts, environment fingerprint (OS, architecture, tool
  versions, CI/local marker; never variable values), the preflight that gated the run,
  the per-project roll-up, and every step with its command line, exit code, error,
  bounded output excerpts and `logPath`.
- **`summary.json`:** `status`, `exitCode`, step counts and a `failures` list. A tool can
  decide whether a run passed by reading only this file.
- **`report.html`:** summary cards, a step table, expandable output for failures and
  separate sections for unsupported and skipped steps. It is a single file with no
  external assets.
- **Logs:** the complete captured output of each executed step, headed by its status,
  duration, command and exit code. `BLOCKED`, `UNSUPPORTED` and `SKIPPED` steps never
  ran, so they get no log file, and their reason is in the reports instead.

### Step statuses

| Status | Meaning | Log file |
|---|---|---|
| `PASS` | The check ran and succeeded. | yes |
| `FAIL` | The check ran and failed: non-zero exit, or output judged as a failure (`gofmt -l`). | yes |
| `TIMEOUT` | The check exceeded its time limit. The step is a `FAIL` with `timedOut: true`, and reports classify it separately. | yes |
| `BLOCKED` | A known requirement is missing: a tool, a JDK, installed dependencies, a lockfile, a required variable, or a project that is not what its type says. Nothing ran. | no |
| `UNSUPPORTED` | There is nothing to run for this project: no script, no tool configuration, or an unknown step id. Nothing ran. | no |
| `SKIPPED` | Deliberately not run, because of `failFast` or cancellation. | no |
| `CANCELLED` | Interrupted by Ctrl+C. | yes |
| `ERROR` | An internal fault prevented a verdict. | no |

None of these is ever reported as `PASS`, and a pipeline made only of unsupported steps
fails. The console shows both `Result` (pass or fail) and, when it is more specific, an
`Outcome` such as `BLOCKED` or `TIMEOUT`.

**Coverage** is read only from a real Istanbul `coverage/coverage-summary.json` written by
this run's passing `coverage` step. Otherwise it is shown as `unavailable` or
`UNSUPPORTED`, never as an invented `0%`.

### Investigating a failed or blocked step

1. Read the reason the console prints under **Failed step** or **Blocked step**. A block
   names the missing requirement and the fix.
2. Run `local-ci-runner report <run-id>` to see a stored run again, or open
   `report.html`.
3. Open `logs/<step>.log` for the step's complete output and exact command.
4. Run `local-ci-runner doctor` to see, for each project, what can run, the evidence it
   is based on, and what is missing.

`doctor` and `preflight` rate each check as `PASS`, `WARNING` (workable; never blocks),
`BLOCKED`, `UNSUPPORTED`, `ERROR` (the check itself failed) or `UNKNOWN` (could not be
verified, so it is never counted as a pass). Only `BLOCKED` and `ERROR` stop steps from
running, and a blocker that applies to particular steps (for example, a missing browser
for tests) blocks only those steps.

## Security and execution model

- **No shell.** Every step is an executable plus an argument vector. No command string
  is built from configuration values.
- **Path containment** *(unreleased)*. `project.path`, `run[0]` paths and `cwd` must be
  relative, free of `..`, and inside the repository or project after symbolic links are
  resolved. Bare program names are looked up only in absolute `PATH` entries.
- **Windows batch-file gate** *(unreleased)*. Arguments that `cmd.exe` would reinterpret
  are rejected for `.cmd`/`.bat` programs instead of being escaped. A project path that
  contains those characters cannot use batch wrappers and is `BLOCKED`.
- **Not a sandbox.** Project scripts, build tools and `run:` commands execute with your
  user account's full permissions, file access and network access. A configuration file
  can choose which program runs, so only run `.local-ci.yml` files and projects you trust.
- **Secret masking is a safety net, not a guarantee.** Before output reaches a report or
  log, it masks:
  - the values of environment variables with credential-like names (`TOKEN`, `SECRET`,
    `PASSWORD`, `PAT`, `KEY`, `PWD`, `DSN` and others);
  - values passed to credential flags such as `--token`;
  - `Authorization`/`Bearer` values, JWTs, GitHub, npm and Slack tokens, and AWS access
    key ids;
  - passwords in connection strings and URLs.

  A secret printed in an unrecognised form is not masked, so keep `.local-ci/` out of
  version control (it ignores itself).
- **No data collection.** There is no telemetry and no upload. `.env` files are never
  read, environment variable values are never written to reports, and required variables
  are checked for presence only.
- **Network use comes from the tools.** `npm audit`/`pnpm audit`, dependency installs and
  restores, and Maven/Gradle wrappers contact their registries. `settings.offline` covers
  only cargo, Gradle and Maven.
- **Process-tree cleanup.** On timeout or cancellation, the whole tree is terminated:
  `taskkill /T /F` on Windows, and a process-group signal on macOS and Linux (TERM, then
  KILL).

## Requirements and troubleshooting

### Requirements

- **Node.js 20.5.0 or later** to run the CLI (`engines` in `package.json`). CI runs the
  test suite on Windows, macOS and Linux with Node 20, 22 and 24, and smoke-tests the
  packed CLI on Node 20.5.0 (Ubuntu and Windows).
- **The project's own toolchain** on `PATH`, or the project's wrapper or virtual
  environment:
  - npm, pnpm, Yarn or Bun;
  - `dotnet`;
  - `python`;
  - `java` plus `mvn`/`gradle` or a wrapper;
  - `php` and `composer`;
  - `go` and `gofmt`;
  - `cargo`, plus `rustfmt`/`clippy` for those steps.

  Toolchains are never downloaded for you.
- **Declared minimums are enforced:** `engines.node`/`.nvmrc`, `global.json`,
  `requires-python`, `composer.json` `require.php`, the `go.mod` `go` line, and a Maven
  `release` of 9+. A version range the checker cannot evaluate is reported as `UNKNOWN`,
  not as satisfied.
- **Browsers:** in a single-project configuration without `project.path` whose type is
  `angular` (or a type with no built-in adapter), if the project's tests use a
  browser-driven runner (Karma, Protractor, Cypress and similar), `doctor` and `preflight`
  look for Chrome or Chromium in the standard install locations. If none is found, the
  test steps are `BLOCKED`. A browser installed elsewhere is not found. Other Node.js
  types (`node`, `react`, `vue`, …), `project.path` and `projects:` configurations do not
  check for a browser.

### Diagnosing problems

```bash
local-ci-runner validate             # is .local-ci.yml valid? which timeout applies?
local-ci-runner doctor               # what each project can run, and why not
local-ci-runner preflight            # would run start, or what blocks it?
local-ci-runner init --all --dry-run # what would be generated from what is on disk
```

| You see | Meaning and fix |
|---|---|
| `Missing .local-ci.yml. Run "local-ci-runner init" first.` | You are not in the directory that holds the configuration. `cd` there, or run `init`. |
| `Invalid .local-ci.yml:` followed by `- settings: Unrecognized key: "timeoutms"` | A key is misspelled or not supported. Each problem is listed with its path. |
| `needs X, but X was not found on PATH` (`BLOCKED`) | Install the tool. Only the steps that need it are blocked. |
| `… was found, but "X --version" did not report a version` | The tool is installed but broken. Repair it. |
| `needs pytest (python -m pytest), but it is not available` | Install pytest into the interpreter `doctor` names (the project's `.venv`, or the global one). |
| `node_modules is missing … no earlier install step` | Install dependencies, or add `install` before the step. |
| `UNSUPPORTED`, e.g. `No "lint" script in package.json` | The project has no script or configuration for that check. Add one, or remove the step. |
| `install` is `BLOCKED` with no lockfile | Commit a lockfile, or install dependencies yourself and remove `install`. |
| `more than one solution` / `both Maven … and Gradle` | Point `project.path` at one, or define the steps with `run:`. |
| `mvnw is not executable` | `chmod +x mvnw`. |
| `Projects not in the configuration` | A project exists that `.local-ci.yml` never runs. Add it, or check `init --all --dry-run`. |
| Passes locally, fails in CI (or the reverse) | Compare tool versions in the report's environment fingerprint with CI's. Check for CI-only secrets, services, OS differences and caches; Local CI Runner does not reproduce them. |

**Platform notes**

- **Windows:** `.cmd`/`.bat` shims (`npm`, `mvnw.cmd`, `gradlew.bat`, `vendor\bin\*.bat`)
  are supported, subject to the batch-file gate above.
- **macOS/Linux:** wrappers and `vendor/bin` tools must be executable.
- **npm `allow-scripts`:** `npm test`, `npm run` and `npx` export your npm settings to
  child processes as `npm_config_*` variables. With npm 11 and an `allow-scripts`
  setting, a child `npm ci` can fail with `EALLOWSCRIPTS`. That is npm's behaviour. Run
  `local-ci-runner` directly, or unset the variable.

## Development and contributing

```bash
git clone https://github.com/dm-bishnoi/local-ci.git
cd local-ci
npm ci
npm run typecheck      # tsc --noEmit
npm test               # vitest run (the full suite takes several minutes)
npm run build          # compile to dist/
npm run dev -- doctor  # run the CLI from source with tsx
```

- `tests/real` runs the real toolchains. Tests for tools you do not have are skipped,
  unless you require them all, as CI does:

  ```bash
  LOCAL_CI_REAL_TOOLCHAINS=required npx vitest run tests/real
  ```

- `demo/phase2-demo.mjs`, `demo/phase4-cancel-e2e.mjs` and
  `demo/phase4.5-process-tree.mjs` exercise the engine, cancellation against the built
  CLI, and process-tree cleanup.
- Layout:
  - `src/core`: process, step and pipeline engine, statuses.
  - `src/ecosystems`: detection and per-ecosystem adapters.
  - `src/adapters/angular`
  - `src/config`: schema and loader.
  - `src/diagnostics`: doctor and preflight.
  - `src/reporters`
  - `src/env`: tool probes, browsers, fingerprint.

**Contributing.** Open an issue or a pull request on
[GitHub](https://github.com/dm-bishnoi/local-ci).
- Add tests with every behaviour change, and keep `npm run typecheck`, `npm test` and
  `npm run build` passing.
- Do not document an ecosystem, tool or platform as verified unless a test has run it
  for real.
- Changes are recorded in [`CHANGELOG.md`](CHANGELOG.md).

## Roadmap and limitations

**Implemented**

- The pipeline engine: timeouts, cancellation, process-tree cleanup and `failFast`.
- The Angular adapter and `package.json` script steps (released in 0.2.0).
- `doctor`, `preflight`, the environment fingerprint, and console/JSON/HTML/log reports
  with secret masking.
- *(Unreleased)* Node.js, .NET, Python, Java, PHP, Go and Rust adapters, `projects:`,
  `run:` steps, project discovery in `init`, and `settings.offline`.

**Not implemented**

- **Azure DevOps and GitHub Actions YAML are not imported or executed.** `.local-ci.yml`
  is the only configuration, and there is no automatic support for arbitrary CI
  pipelines or build tools.
- Comparing a local run's fingerprint with a CI run's (the fingerprint is recorded for
  this).
- Docker or service containers, and sandboxed execution.

**Known limitations**

- The version-range checker supports a subset of semver (`>=`, `<`, `^`, `~`, x-ranges,
  `||`). Anything else is `UNKNOWN`.
- Workspace patterns support literal paths, `*` and a trailing `**`. Others are
  reported, not expanded.
- Browser detection checks only standard install locations.
- `.env` files are never loaded. Set required variables in your shell.
- See [Verification status](#verification-status) for which ecosystems have been run
  against real tools.

## License

[MIT](LICENSE)
