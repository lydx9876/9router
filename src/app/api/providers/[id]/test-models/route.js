import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { getProviderModels, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { pingModelByKind } from "@/app/api/models/test/ping";

// Probes are fired one model at a time. A provider that reports "model queued" (qoder)
// serialises per account, so parallel probes fight for the same queue slot and every
// one of them times out: 16 concurrent qdcn probes took 15s and failed together. A
// small pool keeps the route responsive without manufacturing contention.
const PROBE_CONCURRENCY = 3;

async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += 1) results.push(undefined);
  let next = 0;
  const runWorker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(runWorker());
  await Promise.all(workers);
  return results;
}

/**
 * POST /api/providers/[id]/test-models
 * id = connectionId — used only to resolve provider + model list.
 * Actual requests go through the internal endpoint that matches each model kind.
 */
export async function POST(_request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const providerId = connection.provider;
    const isCompatible = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    let models = getProviderModels(alias);

    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

    // Compatible providers: fetch live model list
    if (isCompatible && models.length === 0) {
      try {
        const modelsRes = await fetch(`${baseUrl}/api/providers/${id}/models`);
        if (modelsRes.ok) {
          const data = await modelsRes.json();
          models = (data.models || []).map((m) => ({ id: m.id || m.name, name: m.name || m.id }));
        }
      } catch { /* fallback to empty */ }
    }

    if (models.length === 0) {
      return NextResponse.json({ error: "No models configured for this provider" }, { status: 400 });
    }

    // Warm up with the first model to trigger token refresh (if needed) before the
    // pooled probes start. This prevents a race where several probes concurrently
    // refresh the same token.
    const [first, ...rest] = models;
    const firstKind = first.kind || first.type || "llm";
    const firstResult = await pingModelByKind(`${alias}/${first.id}`, firstKind, baseUrl);
    const results = [{ modelId: first.id, name: first.name || first.id, ...firstResult }];

    if (rest.length > 0) {
      // Ping returns a result object for every outcome (including transport failures),
      // but keep a guard so one unexpected throw can never erase the other results.
      const restResults = await mapWithConcurrency(rest, PROBE_CONCURRENCY, async (model) => {
        const kind = model.kind || model.type || "llm";
        try {
          const result = await pingModelByKind(`${alias}/${model.id}`, kind, baseUrl);
          return { modelId: model.id, name: model.name || model.id, ...result };
        } catch (err) {
          return {
            modelId: model.id,
            name: model.name || model.id,
            ok: false,
            latencyMs: 0,
            status: 0,
            error: err?.message || String(err),
          };
        }
      });
      results.push(...restResults);
    }

    return NextResponse.json({ provider: providerId, connectionId: id, results });
  } catch (error) {
    console.log("Error testing models:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
