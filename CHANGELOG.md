# Changelog

All notable changes to `@dm-bishnoi/local-ci-runner` are documented here.

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
