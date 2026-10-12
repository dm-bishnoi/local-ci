# F-3: generic `script` step — design proposal

Status: proposed, then implemented in the same change (see "Implementation status").

## Problem

Only Angular projects have step implementations. A project of any other kind
(`project.type: node`, a CLI package, a library) gets `UNSUPPORTED` for every
step, and an Angular project cannot add a step the adapter does not know
(`e2e`, `format`, `docs`). The configuration has no way to say "run this
project script".

## Smallest safe design

Add an optional top-level `steps` map. A pipeline id that has an entry in
`steps` runs that `package.json` script through the project's package manager.
`pipeline` stays a list of ids, unchanged.

```yaml
version: 1
project:
  type: node            # any value; "angular" keeps its built-in steps
pipeline:
  - lint
  - test
  - e2e
steps:
  lint:
    script: lint
  e2e:
    script: "test:e2e"
    timeoutMs: 600000   # optional, overrides settings.timeoutMs for this step
settings:
  failFast: true
```

- `steps.<id>.script` (required): the name of a script in `package.json`.
- `steps.<id>.timeoutMs` (optional): positive integer, at most 24 h.
- Every other key is rejected (the schema is strict).
- Every key of `steps` must also appear in `pipeline`, so a typo cannot define
  a step that never runs.
- A `steps` entry **replaces** the built-in implementation of the same id, so
  `steps.lint` overrides the Angular adapter's `lint`. Nothing else about the
  Angular adapter changes.

Execution is `<packageManager> run <script>` as an argument vector, through the
existing `createProcessStep` / `runProcess` path. No shell string is built.

## Why this shape

| Choice | Reason |
|---|---|
| Separate `steps` map, not objects inside `pipeline` | `pipeline` is read as `string[]` in the runner, run command, preflight, doctor and reports. Changing its type touches all of them; a side map touches only where the registry and diagnostics are built. |
| `script` names only, no `command` / argv | A script name is already trusted project code (`npm run test` runs it today). A free `command` in `.local-ci.yml` would let a cloned repository's config launch any executable the moment someone runs `local-ci-runner run`. That is a separate, larger trust decision. |
| No `args` | Forwarded arguments cross two quoting layers (npm, then the script's shell) and differ per package manager. Deferred until there is a concrete need and a tested escaping story. |
| Strict script-name pattern | Names are used as a single argv entry. Restricting them to letters, digits and `: . _ / -`, with a letter or digit first, makes option injection (`--foo`) and shell metacharacters impossible by construction instead of by quoting. |
| Missing script is `UNSUPPORTED` | Same status the Angular adapter uses for "no lint script". Exit code is non-zero; it is never a pass and never an `ERROR`. |
| Override rather than reject duplicates | Lets an Angular project point `lint` at its own script without a rename. |

## Behaviour preserved by construction

Exit codes, timeouts, cancellation, process-tree cleanup, secret masking, logs
and JSON/HTML reports all come from `createProcessStep`; the script step adds
no execution code of its own. `failFast` is handled by the pipeline runner by
id and does not care how a step is implemented.

## Not in this change

- `command` / argv steps, `args`, environment injection per step.
- Per-step working directory (monorepo sub-packages): run the CLI from the
  package directory, as today.
- Yarn Berry / Plug'n'Play specifics beyond `yarn run`.
- Any change to how the Angular adapter resolves its own steps.

## Implementation status

Implemented. See the final report for the files changed and the tests added.
