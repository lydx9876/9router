import { DefaultExecutor } from "./default.js";

/**
 * Executor for the self-hosted node providers: `custom-embedding-*` and
 * `custom-rerank-*`.
 *
 * These nodes point at a server the user runs, and the URL lives in the
 * connection's providerSpecificData.baseUrl — there is no registry entry for
 * them, so DefaultExecutor falls back to its own baseUrl. For a node named
 * "Custom Embedding" that fallback is api.openai.com, which silently ships the
 * user's payload and API key to OpenAI.
 *
 * The base URL is taken from the connection instead, and when it is missing the
 * request fails with an explanation instead of going to the wrong host.
 */
export class CustomNodeExecutor extends DefaultExecutor {
  constructor(provider) {
    super(provider);
  }

  /**
   * @param {string} model
   * @param {boolean} stream
   * @param {number} urlIndex
   * @param {object} credentials
   * @returns {string}
   */
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const baseUrl = this.getNodeBaseUrl(credentials);
    if (!baseUrl) {
      throw new Error(
        `${this.provider}: no base URL is configured for this node. Edit the node and set ` +
          "its Base URL (the connection stores it under providerSpecificData.baseUrl). " +
          "Refusing to guess a default — sending the request elsewhere would leak the " +
          "API key to a host you did not choose.",
      );
    }
    const trimmed = baseUrl.replace(/\/$/, "");

    if (this.provider?.startsWith?.("custom-rerank-")) {
      return `${trimmed.replace(/\/rerank$/, "")}/rerank`;
    }
    if (this.provider?.startsWith?.("custom-embedding-")) {
      // An embedding node serves /embeddings. A chat request aimed at one is a
      // mistake — say so instead of posting the conversation somewhere else.
      throw new Error(
        `${this.provider} is an embedding node and only serves POST /embeddings. ` +
          "It cannot be used for chat completions — point the chat request at a chat " +
          "provider, or use the node through the embeddings endpoint.",
      );
    }
    return trimmed;
  }

  /**
   * The base URL configured on the node.
   *
   * @param {object} credentials
   * @returns {string} empty string when unset
   */
  getNodeBaseUrl(credentials) {
    const raw = credentials?.providerSpecificData?.baseUrl || "";
    return String(raw).trim();
  }

  buildHeaders(credentials, stream = true, url = null, model = null, body = null, providerSessionId = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body, providerSessionId);
    // These nodes are usually local servers that ignore the key, but when one
    // is configured it should be sent.
    const apiKey = credentials?.apiKey || credentials?.accessToken;
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }
}

export default CustomNodeExecutor;
