import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { getExecutor } from "../executors/index.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { getRerankAdapter } from "./rerankProviders/index.js";

/**
 * Core rerank handler — orchestrator only. Provider-specific URL/headers/body/normalize
 * live in `./rerankProviders/{id}.js`.
 *
 * Mirrors embeddingsCore.js: same shape of request/response, different body
 * fields. Rerank takes a query plus a list of documents and returns them
 * reordered by relevance.
 *
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleRerankCore({
  body,
  modelInfo,
  credentials,
  log,
  onCredentialsRefreshed,
  onRequestSuccess,
}) {
  const { provider, model } = modelInfo;

  // Validate input — query and documents are both required.
  const query = body.query;
  if (typeof query !== "string" || !query.trim()) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: query");
  }

  const documents = body.documents;
  if (!Array.isArray(documents) || documents.length === 0) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      "Missing required field: documents (must be a non-empty array of strings)",
    );
  }
  if (!documents.every((d) => typeof d === "string")) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "documents must be an array of strings");
  }

  const adapter = getRerankAdapter(provider);
  if (!adapter) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support rerank.`,
    );
  }

  const ctx = { query, documents };
  let url, headers, requestBody;
  try {
    url = adapter.buildUrl(model, credentials, ctx);
    headers = adapter.buildHeaders(credentials, ctx);
    requestBody = adapter.buildBody(model, {
      query,
      documents,
      top_n: body.top_n,
      return_documents: body.return_documents,
    });
  } catch (error) {
    log?.debug?.("RERANK", `Request build failed: ${error.message}`);
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `[${provider}/${model}] ${error.message}`);
  }

  log?.debug?.(
    "RERANK",
    `${provider.toUpperCase()} | ${model} | documents=${documents.length}` +
      (body.top_n ? ` | top_n=${body.top_n}` : ""),
  );

  let providerResponse;
  try {
    providerResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      ...(typeof AbortSignal?.timeout === "function"
        ? { signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS) }
        : {}),
    });
  } catch (error) {
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("RERANK", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 — try token refresh (skip for noAuth providers)
  const executor = getExecutor(provider);
  if (
    !executor?.noAuth &&
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
    const newCredentials = await refreshWithRetry(
      () => executor.refreshCredentials(credentials, log),
      3,
      log,
    );

    if (newCredentials?.accessToken || newCredentials?.apiKey) {
      log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for rerank`);
      Object.assign(credentials, newCredentials);
      if (onCredentialsRefreshed) await onCredentialsRefreshed(newCredentials);

      try {
        const retryHeaders = adapter.buildHeaders(credentials, ctx);
        const retryUrl = adapter.buildUrl(model, credentials, ctx);
        providerResponse = await fetch(retryUrl, {
          method: "POST",
          headers: retryHeaders,
          body: JSON.stringify(requestBody),
        });
      } catch {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
      }
    } else {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
    }
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse);
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("RERANK", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg);
  }

  let responseBody;
  try {
    responseBody = await providerResponse.json();
  } catch {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
  }

  if (onRequestSuccess) await onRequestSuccess();

  const normalized = adapter.normalize(responseBody, model, { documents });
  log?.debug?.("RERANK", `Success | results=${normalized.results?.length ?? 0}`);

  return {
    success: true,
    // Rerank responses carry no token counts — there is nothing to bill by
    // tokens, so usage stays null and the usage panel skips the request.
    usage: null,
    response: new Response(JSON.stringify(normalized), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
