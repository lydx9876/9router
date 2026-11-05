// Conversation payload fields stored in the details database. Returning them
// without redaction lets anyone who can reach the dashboard read every
// conversation, so they are dropped unless the operator opts in.
export const REDACTED_KEYS = ["request", "providerRequest", "providerResponse", "response"];

/**
 * Blank the conversation payloads of stored request details.
 *
 * When `showPayloads` is true the records pass through untouched — the operator
 * turned the option on in Settings → Observability.
 *
 * @param {Array<object>} details records from getRequestDetails()
 * @param {{ showPayloads?: boolean }} [options]
 */
export function redactDetails(details, { showPayloads = false } = {}) {
  const list = details || [];
  if (showPayloads) return list;

  return list.map((detail) => {
    if (!detail || typeof detail !== "object") return detail;
    const redacted = { ...detail };
    for (const key of REDACTED_KEYS) {
      if (redacted[key] !== undefined) {
        redacted[key] = { redacted: true };
      }
    }
    return redacted;
  });
}