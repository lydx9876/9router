// Rerank provider adapter registry
import customRerank from "./customRerank.js";

export function getRerankAdapter(provider) {
  // Node ids look like "custom-rerank-<uuid>" — the prefix is the constant,
  // so match on that rather than on a literal id.
  if (provider?.startsWith?.("custom-rerank-")) {
    return customRerank;
  }
  return null;
}
