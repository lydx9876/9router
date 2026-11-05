"use client";

import { useState, useEffect } from "react";
import { Card } from "@/shared/components";
import { getProviderAlias, isCustomRerankProvider } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { translate } from "@/i18n/runtime";
import { Row } from "./exampleShared";

const DEFAULT_RESPONSE_EXAMPLE = `{
  "id": "...",
  "results": [
    { "index": 0, "relevance_score": 0.98, "document": "..." },
    { "index": 2, "relevance_score": 0.87, "document": "..." }
  ]
}`;

const DEFAULT_DOCUMENTS = [
  "JavaScript closures capture variables from their enclosing scope.",
  "The Eiffel Tower is located in Paris, France.",
  "A closure is a function bundled together with its lexical environment.",
];

/**
 * Example call card for a rerank endpoint.
 *
 * Rerank takes a query plus a list of documents and returns them ordered by
 * relevance — so the input is two things (query + documents), and the output
 * is a scored table rather than a JSON blob.
 */
export function RerankExampleCard({ providerId, customAlias }) {
  const isCustom = isCustomRerankProvider(providerId);
  const providerAlias = isCustom ? (customAlias || providerId) : getProviderAlias(providerId);

  const [selectedModel, setSelectedModel] = useState("");
  const [query, setQuery] = useState("What is a closure in JavaScript?");
  const [documents, setDocuments] = useState(DEFAULT_DOCUMENTS.join("\n"));
  const [topN, setTopN] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const { copied: copiedCurl, copy: copyCurl } = useCopyToClipboard();
  const { copied: copiedRes, copy: copyRes } = useCopyToClipboard();

  useEffect(() => {
    setLocalEndpoint(window.location.origin);
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => { setApiKey((d.keys || []).find((k) => k.isActive !== false)?.key || ""); })
      .catch(() => {});
    fetch("/api/tunnel/status")
      .then((r) => r.json())
      .then((d) => { if (d.publicUrl) setTunnelEndpoint(d.publicUrl); })
      .catch(() => {});
  }, []);

  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  const modelFull = selectedModel.trim() ? `${providerAlias}/${selectedModel.trim()}` : "";

  const docList = documents.split("\n").map((d) => d.trim()).filter(Boolean);

  const buildBody = () => {
    const body = { model: modelFull, query: query.trim(), documents: docList };
    const n = Number(topN);
    if (topN && Number.isFinite(n) && n > 0) body.top_n = n;
    return body;
  };

  const curlSnippet = `curl -X POST ${endpoint}/v1/rerank \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey || "YOUR_KEY"}" \\
  -d '${JSON.stringify(buildBody())}'`;

  const handleRun = async () => {
    if (!query.trim() || !docList.length || !modelFull) return;
    setRunning(true);
    setError("");
    setResult(null);
    const start = Date.now();
    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch("/api/v1/rerank", {
        method: "POST",
        headers,
        body: JSON.stringify(buildBody()),
      });
      const latencyMs = Date.now() - start;
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message || data?.error || `HTTP ${res.status}`); return; }
      setResult({ data, latencyMs });
    } catch (e) {
      setError(e.message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  const resultJson = result ? JSON.stringify(result.data, null, 2) : "";
  const scored = Array.isArray(result?.data?.results) ? result.data.results : [];

  return (
    <Card>
      <h2 className="text-lg font-semibold mb-4">Example</h2>

      <div className="flex flex-col gap-2.5">
        {/* Model — free text: rerank models come from the node, not a registry list */}
        <Row label="Model">
          <input
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            placeholder="e.g. BAAI/bge-reranker-v2-m3, jina-reranker-v2-base-multilingual"
            className="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary font-mono"
          />
        </Row>

        {/* Endpoint */}
        <Row label="Endpoint">
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <input
              value={endpoint}
              onChange={(e) => useTunnel ? setTunnelEndpoint(e.target.value) : setLocalEndpoint(e.target.value)}
              className="w-full min-w-0 flex-1 px-3 py-1.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary font-mono"
              placeholder="http://localhost:3000"
            />
            {tunnelEndpoint && (
              <button
                onClick={() => setUseTunnel((v) => !v)}
                title={useTunnel ? "Using tunnel" : "Using local"}
                className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border shrink-0 transition-colors ${
                  useTunnel ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-text-muted hover:text-primary"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">wifi_tethering</span>
                Tunnel
              </button>
            )}
          </div>
        </Row>

        {/* API Key */}
        <Row label="API Key">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary font-mono"
          />
        </Row>

        {/* Query */}
        <Row label="Query">
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What is a closure in JavaScript?"
              className="w-full px-3 py-1.5 pr-7 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            )}
          </div>
        </Row>

        {/* Documents — one per line */}
        <Row label="Documents">
          <textarea
            value={documents}
            onChange={(e) => setDocuments(e.target.value)}
            rows={5}
            placeholder="One document per line"
            className="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary font-mono resize-y"
          />
          <span className="text-xs text-text-muted">
            {`${docList.length} ${translate(docList.length === 1 ? "document" : "documents")}`}
          </span>
        </Row>

        {/* top_n */}
        <Row label="Top N">
          <input
            type="number"
            min="1"
            value={topN}
            onChange={(e) => setTopN(e.target.value)}
            placeholder="optional, e.g. 3 (leave empty for all)"
            className="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
        </Row>

        {/* Curl + Run */}
        <div className="mt-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-1.5">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">Request</span>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <button
                onClick={() => copyCurl(curlSnippet)}
                className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">{copiedCurl ? "check" : "content_copy"}</span>
                {copiedCurl ? "Copied" : "Copy"}
              </button>
              <button
                onClick={handleRun}
                disabled={running || !query.trim() || !docList.length || !modelFull}
                className="flex w-full sm:w-auto items-center justify-center gap-1.5 px-3 py-1 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-[14px]" style={running ? { animation: "spin 1s linear infinite" } : undefined}>
                  play_arrow
                </span>
                {running ? "Running..." : "Run"}
              </button>
            </div>
          </div>
          <pre className="bg-sidebar rounded-lg px-3 py-2.5 text-xs font-mono text-text-main overflow-x-auto whitespace-pre-wrap break-all">{curlSnippet}</pre>
        </div>

        {/* Error */}
        {error && <p className="text-xs text-red-500 break-words">{error}</p>}

        {/* Scored results */}
        {scored.length > 0 && (
          <div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-1.5">
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Ranking <span className="font-normal normal-case">&#9889; {result.latencyMs}ms</span>
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {scored.map((r, i) => {
                const score = typeof r.relevance_score === "number" ? r.relevance_score : null;
                return (
                  <div key={`${r.index}-${i}`} className="bg-sidebar rounded-lg px-3 py-2">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-mono text-text-muted">#{i + 1} · index {r.index}</span>
                      {score != null && (
                        <span className="font-mono font-semibold text-primary">{score.toFixed(4)}</span>
                      )}
                    </div>
                    {score != null && (
                      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-border">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(0, Math.min(100, score * 100))}%` }}
                        />
                      </div>
                    )}
                    {r.document != null && (
                      <p className="mt-1.5 line-clamp-2 text-xs text-text-main">
                        {typeof r.document === "string" ? r.document : JSON.stringify(r.document)}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Response — default example or real result */}
        <div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-1.5">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">Response</span>
            {result && (
              <button
                onClick={() => copyRes(resultJson)}
                className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">{copiedRes ? "check" : "content_copy"}</span>
                {copiedRes ? "Copied" : "Copy"}
              </button>
            )}
          </div>
          <pre className="bg-sidebar rounded-lg px-3 py-2.5 text-xs font-mono text-text-main overflow-x-auto whitespace-pre-wrap break-all opacity-70">
            {result ? resultJson : DEFAULT_RESPONSE_EXAMPLE}
          </pre>
        </div>
      </div>
    </Card>
  );
}
