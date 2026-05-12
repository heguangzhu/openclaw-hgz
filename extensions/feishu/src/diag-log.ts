/**
 * Gate for [DIAG-*] timing/instrumentation logs sprinkled across hot paths.
 * Enabled by default; set OPENCLAW_DIAG=0 (or "false") to silence.
 *
 * Read once at module load — toggling requires daemon restart, which fits the
 * intended workflow (flip env var → restart → re-test).
 *
 * Mirrored from src/utils/diag-log.ts so the feishu extension can stay
 * self-contained (extensions cannot import directly from src/).
 */
const DIAG_ENABLED = (() => {
  const v = process.env.OPENCLAW_DIAG;
  if (v === undefined) return true;
  return v !== "0" && v.toLowerCase() !== "false";
})();

export function diagLog(category: string, message: string): void {
  if (!DIAG_ENABLED) return;
  console.error(`[DIAG-${category}] ${new Date().toISOString()} ${message}`);
}
