/**
 * Controlled shutdown for a pipeline run.
 *
 * The CLI wires exactly one cancellation object per command invocation and
 * disposes it in a `finally` block, so repeated commands never stack duplicate
 * `SIGINT`/`SIGTERM` handlers on the process.
 */

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export interface RunCancellation {
  /** Signal threaded through PipelineRunner -> StepRunner -> ProcessRunner. */
  readonly signal: AbortSignal;
  /** True once cancellation has been requested. */
  readonly cancelled: boolean;
  /** True while listeners are attached to the process. */
  readonly active: boolean;
  /** Requests cancellation programmatically (used by tests and by the CLI). */
  cancel(reason?: string): void;
  /** Removes the process listeners. Safe to call more than once. */
  dispose(): void;
}

/** Number of cancellations currently holding process signal listeners. */
let activeCount = 0;

export function activeCancellations(): number {
  return activeCount;
}

export function createRunCancellation(
  onCancel?: (reason: string) => void,
  signals: readonly NodeJS.Signals[] = DEFAULT_SIGNALS,
): RunCancellation {
  const controller = new AbortController();
  const handlers: Array<[NodeJS.Signals, () => void]> = [];

  let cancelled = false;
  let disposed = false;

  const cancel = (reason: string): void => {
    if (cancelled) return;
    cancelled = true;
    onCancel?.(reason);
    controller.abort(new Error(reason));
  };

  for (const signalName of signals) {
    const handler = (): void => {
      cancel(`Received ${signalName}.`);
    };
    handlers.push([signalName, handler]);
    process.on(signalName, handler);
  }
  activeCount += 1;

  return {
    signal: controller.signal,
    get cancelled() {
      return cancelled;
    },
    get active() {
      return !disposed;
    },
    cancel,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [signalName, handler] of handlers) {
        process.removeListener(signalName, handler);
      }
      handlers.length = 0;
      activeCount -= 1;
    },
  };
}