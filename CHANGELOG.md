# Changelog

All notable changes to `@dm-bishnoi/local-ci-runner` are documented here.

## 0.3.0

Multi-language support. See the README section "Languages and ecosystems" for the exact
commands, requirements and detection rules, and "Verification status" for what has been
exercised against real tools and what has only been tested with fake ones.

### Added

- **Ecosystems:** Node.js (JavaScript, TypeScript, React, Vue, Angular, with npm, pnpm,
  Yarn and Bun), .NET, Python, Java (Maven and Gradle), PHP (Composer), Go and Rust.
  Checks are detected from the project, never assumed: an explicit script always wins, a
  tool is inferred only from a declared dependency *plus* its configuration, and a tool
  that is configured but not installed is `BLOCKED`.
- **`projects:`** in `.local-ci.yml` for monorepos and mixed-language repositories, with
  project-qualified step ids (`web.build`), a per-project roll-up in the console, JSON
  and HTML reports, and `run --project <name>`. One blocked project never stops another.
  `project.path` points a single project at a subdirectory.
- **`steps.<id>.run`:** a custom command as an argument list (never a shell string),
  with executable and working-directory containment and a Windows `.cmd`/`.bat`
  argument gate that rejects `cmd.exe` metacharacters instead of escaping them.
- **`init`** detects projects (workspace metadata first, then a bounded scan that never
  follows symlinks) and gains `--dry-run`, `--type`, `--path`, `--all`, `--scan-depth`
  and `--ignore`. It refuses to guess between several projects, never overwrites
  without `--force`, validates what it writes, leaves out steps whose tool is missing,
  and keeps the Angular output byte-identical.
- **`doctor`** lists what each project can run and why not, and warns about projects
  the configuration does not cover, directories the scan depth did not reach, and
  workspace patterns it cannot expand.
- **`settings.offline`** (cargo, Gradle and Maven).
- `tests/real` and a `Real toolchains` CI job (Ubuntu, Windows and macOS) that run the actual
  toolchains and fail, rather than skip, when one is missing. This includes real Maven and
  Gradle builds (compile, test, verify, build, a failing JUnit test and a compile error).
- CI fails on any skipped test outside a short list of expected ones, and installs the packed
  tarball into an empty directory to run `init`, `doctor` and `run` for Node, Python, Go, Rust,
  .NET and PHP projects (`scripts/smoke-packed.mjs`).

### Behaviour changes

- A `project.type` that is a recognised ecosystem (`node`, `react`, `python`, …) now gets
  its built-in checks. A step you did not script, which used to be `UNSUPPORTED`, may now
  run, or be `BLOCKED`/`UNSUPPORTED` for a concrete reason. `steps:` still wins.
- A `project.type` that is not recognised keeps its 0.2.0 behaviour (only `steps:` run)
  and now produces a warning in `validate`, `doctor` and `preflight`. No configuration
  stops loading.
- `init` with more than one project found refuses and lists them (use `--all`, `--path`
  or `--dry-run`) instead of writing the Angular default.
- A missing external tool is now reported as missing on Linux and macOS as well; before,
  some probes read it as unverified. A tool that exists but cannot report a version is
  reported as found-but-broken (for example a `dotnet` that cannot load).
- A probe for a module or subcommand (`python -m pytest --version`) must exit 0; its
  error text is no longer mined for a version. This fixed a real case where a missing
  `pytest` looked installed because the interpreter's install path contained `3.14-64`.

### Fixed

- `steps: { x: { run: [] } }` could crash validation instead of reporting an error.
- The Java `init` error no longer mentions the "build is part of verify" note when no step could be written.
- A tool probe that timed out on a heavily loaded machine was reported as a missing tool and blocked
  the step. It is now reported as "could not be checked" (a warning) and the step runs. The probe limit
  is 20 s (it was 8 s); a tool that is not installed is still reported at once.

## 0.2.0

### Behaviour changes from 0.1.1

Review these before upgrading. A configuration or project that worked with
0.1.1 can fail or behave differently with 0.2.0.

- **Unknown configuration keys are rejected.** Every section of `.local-ci.yml`
  is now strict. A key 0.1.1 silently ignored, such as a misspelled
  `timeoutms` or `failfast`, now fails `validate` and `run` with a message
  naming the key and its location.
- **Steps have a default time limit.** When `settings.timeoutMs` is not set,
  `run` now applies 30 minutes (1800000 ms) per step instead of no limit.
  `validate` prints the effective timeout and whether it is the default. Set
  `settings.timeoutMs` (at most 24 hours) to change it.
- **The built-in `install` step is blocked without a lockfile.** In 0.1.1 a
  project without a lockfile ran `npm install`, which creates a lockfile and can
  resolve different versions than CI. 0.2.0 reports `install` as BLOCKED
  instead. Commit a lockfile, remove `install` from the pipeline, or define
  `install` yourself under `steps`.
- **Node.js 20.5.0 or later is required** (was `>=20`).

### Added

- **Package.json script steps.** A new `steps` section maps a pipeline step id
  to a `package.json` script, run as `npm run <script>` (or `pnpm run` /
  `yarn run`, following the lockfile). Any `project.type` can use it, so a
  plain Node.js project can now be checked, and an Angular project can add
  steps the adapter does not know (such as `e2e`) or point a built-in step at a
  different script.
  - The script name is passed as a single argument; no shell command string is
    built. Names are limited to letters, digits and `: . _ / -`, must start
    with a letter or digit, and may not contain a `..` segment.
  - A step may set its own `timeoutMs`, which can be longer or shorter than
    `settings.timeoutMs`.
  - Each `steps` key must appear in `pipeline`, and only `script` and
    `timeoutMs` are accepted.
  - A script that is missing or empty in `package.json` reports `UNSUPPORTED`
    without running anything, and `doctor` and `preflight` flag it in advance.
  - Exit codes, timeouts, cancellation, `failFast`, process-tree cleanup,
    secret masking and reports behave as for every other step.
- **`init` fits the pipeline to the project.** In an Angular project, `init`
  now lists only the default steps the project can run. Steps it cannot run
  yet, such as `typecheck`, `coverage` or `lint` without a matching script or
  coverage provider, or `install` without a lockfile, are written as commented
  lines with the reason and named in the output. A freshly generated Angular
  project therefore no longer fails its first `run` on unsupported steps.
  Outside an Angular project the full default pipeline is written, as before.
  Existing `.local-ci.yml` files are not changed.
- **Report directory protection.** `init` and `run` create
  `.local-ci/.gitignore` (containing `*`) so stored reports stay out of version
  control. An existing file is never overwritten, and the project's own
  `.gitignore` is never edited.
- **Workspace lockfile detection.** A package inside a monorepo with no
  lockfile of its own uses the lockfile at its workspace root. A root counts
  only if it declares a workspace (`pnpm-workspace.yaml` or a `workspaces`
  field), and the search stops at the enclosing git repository.

### Improved

- **Process cleanup and timeouts.**
  - A step now finishes only after its process tree has exited, so the next
    step never starts while the previous one is still shutting down.
  - Termination is started at most once even when a timeout and a cancellation
    coincide, and stops waiting as soon as the tree is gone.
  - A timed-out or cancelled step keeps its evidence: the command line, exit
    details and the output printed before it was stopped appear in
    `report.json`, `report.html` and its log.
- **Node.js version checks.** `engines.node` and `.nvmrc` ranges now support
  `||` alternatives, comparator sets (`>=18 <21`), whitespace after operators
  (`>= 18`), caret, tilde, x-ranges and partial versions. A range the checker
  cannot evaluate (such as `lts/*` or a hyphen range) is reported as `UNKNOWN`
  and is never treated as satisfied.
- **Credential redaction.**
  - Environment variable names now also match whole name segments `PAT`, `KEY`,
    `PWD`, `PASS` and `DSN` (for example `GH_PAT`, `STRIPE_KEY`, `DB_PWD`), plus
    the words `CONNECTION_STRING` and `WEBHOOK`. The shell's own `PWD` and
    `OLDPWD` are not treated as secrets.
  - Credentials with a recognisable format are masked even when no environment
    variable reveals them: `Authorization:` header values, `Bearer` tokens,
    JWTs, GitHub and npm tokens, `.npmrc` `_authToken=` values, Slack tokens,
    AWS access key ids, and `Password=` / `Pwd=` / `AccountKey=` values in
    connection strings.
- **Cross-platform CI.** The test suite runs on Windows, macOS and Linux with
  Node.js 20.x, 22.x and 24.x, and the packed CLI is smoke-tested on Node.js
  20.5.0.

### Known issues

- A listed step the project cannot run reports `UNSUPPORTED`, and `run` then
  exits 1 even when every executed step passed. This is deliberate: an
  unsupported check is never reported as a pass. Remove the step, add the
  script, or define it under `steps`.
- Text of the form `PWD=<value>` in captured output is masked, because the same
  pattern covers `Pwd=` in database connection strings. Only the value is
  hidden.
- A passing step whose command wrote to stderr (for example npm warnings) shows
  that text in the step's error field in reports.
