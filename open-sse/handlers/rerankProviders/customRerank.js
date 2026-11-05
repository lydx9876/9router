// Custom rerank node provider (custom-rerank-*) — baseUrl from credentials.
//
// Self-hosted rerank servers (vLLM, Infinity, TEI, LocalAI, …) all expose a
// Cohere-compatible POST /rerank:
//
//   { "model": "...", "query": "...", "documents": [...], "top_n": 3 }
//   → { "results": [{ "index": 0, "relevance_score": 0.98 }, ...] }
//
// The baseUrl is the OpenAI-style root ("http://host:8080/v1"); /rerank is
// appended here, matching how the embedding counterpart works.
export default {
  buildUrl: (_model, creds) => {
    const rawBaseUrl = creds?.providerSpecificData?.baseUrl || "http://localhost:8080/v1";
    const baseUrl = rawBaseUrl.replace(/\/$/, "").replace(/\/rerank$/, "");
    return `${baseUrl}/rerank`;
  },

  buildHeaders: (creds) => {
    const apiKey = creds?.apiKey || creds?.accessToken || "";
    const headers = { "Content-Type": "application/json" };
    // Self-hosted servers usually ignore the key, but sending one when the
    // user configured it keeps the door open for a gateway in front.
    if (apiKey && apiKey !== "YOUR_KEY") headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  },

  buildBody: (model, { query, documents, top_n, return_documents }) => {
    const body = { model, query, documents };
    const n = Number(top_n);
    if (top_n != null && top_n !== "" && Number.isFinite(n) && n > 0) body.top_n = n;
    if (typeof return_documents === "boolean") body.return_documents = return_documents;
    return body;
  },

  /**
   * Normalize an upstream rerank response into the cross-vendor shape:
   *
   *   { "id": "...", "results": [{ "index": N, "relevance_score": F }] }
   *
   * The index refers to the position in the ORIGINAL documents array — callers
   * rely on it to map a score back to their own stored document.
   *
   * `document` needs care: servers return it in more than one shape. Gitee AI
   * returns `{ "text": "..." }` (the vLLM/TEI style), Cohere and Jina return
   * the plain string. Rendering the object directly crashed React
   * ("Objects are not valid as a React child"), so the text is unwrapped here
   * and the document is always a string.
   */
  normalize: (responseBody, _model, { documents } = {}) => {
    const rawResults = Array.isArray(responseBody?.results) ? responseBody.results : [];

    const results = rawResults
      .map((r, position) => {
        const index = Number.isInteger(r?.index) ? r.index : position;
        const score = r?.relevance_score ?? r?.score ?? r?.relevance ?? null;
        const entry = { index, relevance_score: score };
        const text = extractDocumentText(r?.document);
        if (text != null) entry.document = text;
        return entry;
      })
      .filter((r) => Number.isFinite(r.relevance_score) || r.relevance_score === null)
      .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0));

    const normalized = {
      id: responseBody?.id ?? responseBody?.request_id ?? null,
      results,
      // LiteLLM-compatible passthrough of any provider-specific metadata.
      ...(responseBody?.meta ? { meta: responseBody.meta } : {}),
    };

    // Echo back the model when the server reports one — useful to confirm
    // which reranker actually ran.
    if (responseBody?.model) normalized.model = responseBody.model;

    // Some servers return the documents array but no per-result document.
    if (documents && normalized.results.length && !normalized.results.some((r) => r.document != null)) {
      for (const r of normalized.results) {
        if (r.index >= 0 && r.index < documents.length) r.document = documents[r.index];
      }
    }

    return normalized;
  },
};

/**
 * Unwrap the several shapes a `document` field comes in.
 *
 *   "plain text"                    → "plain text"
 *   { "text": "..." }                → "..."       (Gitee AI, vLLM, TEI)
 *   { "content": "..." }             → "..."       (some gateways)
 *   { "text": { "value": "..." } }   → "..."
 *
 * @param {unknown} doc
 * @returns {string|null}
 */
function extractDocumentText(doc) {
  if (doc == null) return null;
  if (typeof doc === "string") return doc;
  if (typeof doc !== "object") return String(doc);

  for (const key of ["text", "content", "page_content", "chunk"]) {
    const value = doc[key];
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && typeof value.value === "string") {
      return value.value;
    }
  }
  return null;
}
