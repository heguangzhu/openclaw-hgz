import { diagLog } from "../../utils/diag-log.js";

type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
};

export const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

async function waitForAgentIdleBestEffort(
  agent: IdleAwareAgent | null | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const waitForIdle = agent?.waitForIdle;
  if (typeof waitForIdle !== "function") {
    return false;
  }

  const idleResolved = Symbol("idle");
  const idleTimedOut = Symbol("timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      waitForIdle.call(agent).then(() => idleResolved),
      new Promise<symbol>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(idleTimedOut), timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
    return outcome === idleTimedOut;
  } catch {
    // Best-effort during cleanup.
    return false;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function flushPendingToolResultsAfterIdle(opts: {
  agent: IdleAwareAgent | null | undefined;
  sessionManager: ToolResultFlushManager | null | undefined;
  timeoutMs?: number;
  clearPendingOnTimeout?: boolean;
}): Promise<void> {
  const t0 = Date.now();
  const hasWaitForIdle = typeof opts.agent?.waitForIdle === "function";
  diagLog("IDLE", `flushPendingToolResultsAfterIdle: start hasWaitForIdle=${hasWaitForIdle}`);
  const timedOut = await waitForAgentIdleBestEffort(
    opts.agent,
    opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
  );
  const t1 = Date.now();
  diagLog(
    "IDLE",
    `flushPendingToolResultsAfterIdle: idle-wait-done timedOut=${timedOut} elapsed=${t1 - t0}ms`,
  );
  if (timedOut && opts.clearPendingOnTimeout && opts.sessionManager?.clearPendingToolResults) {
    opts.sessionManager.clearPendingToolResults();
    diagLog(
      "IDLE",
      `flushPendingToolResultsAfterIdle: cleared (timeout) elapsed=${Date.now() - t0}ms`,
    );
    return;
  }
  opts.sessionManager?.flushPendingToolResults?.();
  diagLog("IDLE", `flushPendingToolResultsAfterIdle: flushed elapsed=${Date.now() - t0}ms`);
}
