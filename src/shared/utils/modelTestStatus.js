/**
 * Map a /api/models/test response to the per-model badge state.
 *
 * Three outcomes, not two: a queued model is neither working nor broken. Qoder
 * answers `{"code":"10605","isQueued":true}` or `"Queue wait timed out"` when the
 * model has no capacity at that moment, and the SAME model serves normally once the
 * queue drains. Rendering that as a red failure made a healthy credential look dead
 * and sent people chasing an auth problem that did not exist.
 */
export const MODEL_TEST_OK = "ok";
export const MODEL_TEST_QUEUED = "queued";
export const MODEL_TEST_ERROR = "error";

export function modelTestStatus(result) {
  if (!result) return null;
  if (result.ok) return MODEL_TEST_OK;
  if (result.queued) return MODEL_TEST_QUEUED;
  return MODEL_TEST_ERROR;
}

/**
 * Message to show next to a failed/queued probe. Empty string clears it.
 */
export function modelTestMessage(result) {
  if (!result || result.ok) return "";
  return result.error || "Model not reachable";
}
