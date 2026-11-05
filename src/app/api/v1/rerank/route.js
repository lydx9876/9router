import { handleRerank } from "@/sse/handlers/rerank";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/rerank - Cohere-compatible rerank endpoint
 *
 * Request:
 *   { "model": "alias/model", "query": "...", "documents": ["...", "..."], "top_n": 3 }
 * Response:
 *   { "id": "...", "results": [{ "index": 0, "relevance_score": 0.98 }] }
 */
export async function POST(request) {
  return await handleRerank(request);
}
