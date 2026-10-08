# Local CI Runner

Run CI-style validation locally before pushing to GitHub or Azure DevOps.

> `npx local-ci run`

Local CI Runner is an npm CLI with a framework-agnostic core and framework adapters. Angular is the first planned adapter.

## Phase 1 status

Phase 1 establishes the publishable CLI foundation:

- TypeScript + ESM
- `commander` CLI
- `.local-ci.yml` loading and Zod validation
- `init`, `run`, `validate`, `doctor`, `report`, and `version`
- pipeline/step abstractions
- safe fixed-argument process runner
- JSON + HTML run artifacts
- Vitest coverage for configuration and runner behavior

Angular commands, Azure YAML importing, Docker isolation, and AI analysis are intentionally not part of Phase 1.

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
```

Phase 1 validates the pipeline but does not pretend that Angular steps are executable before the Angular adapter exists. An unregistered step is reported as `UNSUPPORTED` and makes the run fail.

## Security model

The core process runner accepts an executable and an argument array and explicitly disables shell interpretation. The configuration format does not execute arbitrary shell strings in Phase 1. Secrets and `.env` files are not read or uploaded by the tool.

## Roadmap

1. CLI foundation
2. CI engine hardening: timeouts, cancellation, richer logging
3. Angular adapter: dependency checks, typecheck, tests, coverage, lint, build
4. Console/JSON/HTML reporting expansion
5. Azure DevOps YAML adapter/importer with explicit unsupported-task results

Docker and AI integrations remain optional future features.
