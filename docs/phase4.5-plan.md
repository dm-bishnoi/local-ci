# Phase 4.5 implementation plan (from repository audit)

## Audit findings — what is actually there

| Area | Reality |
|---|---|
| `src/core/` | PipelineRunner / StepRunner / ProcessRunner from Phase 2. `StepStatus = PASS\|FAIL\|UNSUPPORTED\|SKIPPED\|CANCELLED`. Timeout is `FAIL` + `timedOut: true` (a flag, not a state). No `BLOCKED`, no `ERROR`. |
| `src/reporters/` | Phase 4 layer exists **but is uncommitted in the working tree** — HEAD is still `3c2e926` (Phase 3). 339 tests pass against it. |
| `src/cli/commands/doctor.ts` | 89 lines. Probes only Node major, `npm`, `git` via `where`/`which`, plus config presence/validity. No project detection, no version checks, no fingerprint, no severity model, no guidance. |
| Config schema | `version`, `project.type`, `pipeline[]`, `settings.{failFast,timeoutMs}`. **No environment/variable requirements.** |
| `run.ts` | Detection → registry → execute → report. **No preflight.** |
| Angular adapter | Detection, package-manager resolution, step→command mapping. No browser or tool-version detection. |
| Tests | No `tests/cli/doctor.test.ts`. No preflight tests. |
| Process tree | `execa` with `cleanup:true` + `forceKillAfterDelay`. Known Windows leak of `npm`-spawned grandchildren (found in Phase 4 E2E). |

## Decisions

1. **TIMEOUT stays backward-compatible.** 68 test references pin timeout as `status:'FAIL'` + `timedOut:true`. Adding `status:'TIMEOUT'` would break Phase 2/3/4 tests, which must keep passing. So: introduce a **canonical `outcome` vocabulary** (`TIMEOUT` first-class) alongside the engine's `status`, derived once in the report model. This satisfies "preserve TIMEOUT" and "TIMEOUT != PASS" with zero regressions.
2. **Add `BLOCKED` and `ERROR`** to `StepStatus`. Nothing produces them today, so no regression risk. Union moves to a new `src/core/status.ts`; `step-runner.ts` re-exports it.
3. **Process-tree cleanup** manages termination itself instead of delegating to execa's timeout/cancel, because execa only kills the direct child.
4. **Doctor stays diagnostic-only** — never executes the pipeline.
5. **No new dependencies.** Minimal semver subset written by hand; browser detection by probing standard install locations per platform.

## Layout

```
src/core/status.ts              canonical StepStatus + RunOutcome + isSuccess   (new)
src/env/fingerprint.ts          environment fingerprint, secret-free            (new)
src/env/semver.ts               minimal range check (no dependency)              (new)
src/env/tools.ts                node/npm/pnpm/yarn/git probes                    (new)
src/env/browser.ts              cross-platform Chrome/Chromium detection         (new)
src/diagnostics/types.ts        CheckSeverity + Diagnostic + DiagnosticReport    (new)
src/diagnostics/doctor.ts       doctor checks                                   (new)
src/diagnostics/preflight.ts    preflight checks                                (new)
src/config/schema.ts            + environment.variables.required                (modified)
src/core/process-runner.ts      process-tree termination                        (modified)
src/core/step-runner.ts         re-export StepStatus from status.ts              (modified)
src/reporters/report-model.ts   + environment, preflight, diagnostics            (modified)
src/reporters/{console,html,summary}.ts  render new sections                     (modified)
src/cli/commands/doctor.ts      production diagnostic                            (rewritten)
src/cli/commands/preflight.ts   new command                                     (new)
src/cli/commands/run.ts         run preflight first                              (modified)
src/cli/index.ts                register preflight                              (modified)
```