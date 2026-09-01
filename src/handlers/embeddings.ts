import { Request, Response as ExpressResponse } from "express";
import { Config } from "../config";

/**
 * OpenAI-compatible `/v1/embeddings` — a straight proxy to a configured upstream.
 *
 * Note there is no provider routing here, unlike every other endpoint in this
 * service. Nothing dispatches an embeddings request by model name, because there is
 * nothing to dispatch between: neither account auth2api holds can serve embeddings
 * at all.
 *
 *   Anthropic publishes no embeddings model. Not "not exposed to us" — none.
 *   https://platform.claude.com/docs/en/build-with-claude/embeddings says so in as
 *   many words and points at Voyage AI instead. Probed 2026-09-01:
 *   POST api.anthropic.com/v1/embeddings -> 404, while /v1/messages -> 401. A route
 *   that does not exist, versus a route that wants auth.
 *
 *   The Codex account's token DOES authenticate against api.openai.com — measured,
 *   not assumed. Posting to /v1/embeddings with it returns 429 billing_not_active,
 *   where a junk token returns 401 invalid_api_key. So the credential is accepted
 *   and the request dies at billing, not at auth; /v1/chat/completions on the
 *   platform API behaves identically. Enable platform billing on that account, or
 *   supply any platform key that has it, and this endpoint works as-is.
 *
 * So this forwards to whatever OpenAI-compatible embeddings service it is pointed
 * at, and does nothing else. Deliberately NOT a local model: auth2api is a
 * credential broker that github-pr-bot, codex-pr-review and others depend on, and
 * bolting an ONNX runtime plus model weights into it would trade their reliability
 * for a convenience.
 *
 * With no upstream configured it fails loudly, rather than returning something
 * plausible-but-wrong. A quietly wrong embedding is the worst outcome available: it
 * poisons a vector store, and every retrieval built on it degrades with no error
 * anywhere to explain why.
 */

export function createEmbeddingsHandler(config: Config) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    const cfg = config.embeddings;

    if (!cfg?.enabled) {
      res.status(404).json({
        error: {
          message:
            "Embeddings are disabled on this auth2api. Set embeddings.enabled: true " +
            "and embeddings.url in config.yaml.",
          type: "invalid_request_error",
        },
      });
      return;
    }

    if (!cfg.url) {
      // The noisy failure. 501 rather than 500: this is an unimplemented capability,
      // not a fault. The message has to be actionable on its own, because whoever
      // reads it will be looking at a WrenAI log and may not know what auth2api is.
      res.status(501).json({
        error: {
          message:
            "auth2api has no embeddings upstream: embeddings.url is not set. " +
            "It cannot generate embeddings itself: Anthropic publishes no embeddings " +
            "model at all. Point embeddings.url at any OpenAI-compatible " +
            "/v1/embeddings service — api.openai.com (the Codex account's own token " +
            "authenticates there, it just needs platform billing active), Voyage AI, " +
            "or an in-cluster Ollama — and set embeddings.api-key.",
          type: "not_implemented",
          code: "embeddings_upstream_not_configured",
        },
      });
      return;
    }

    const body = req.body ?? {};
    if (body.input === undefined || body.input === null) {
      res.status(400).json({
        error: {
          message: "`input` is required",
          type: "invalid_request_error",
        },
      });
      return;
    }

    // The caller's `model` wins; cfg.model is only a default for callers that omit
    // it. That suits both upstreams we care about: llama-server ignores the field
    // entirely (one model is loaded, it echoes the name back), and api.openai.com
    // genuinely serves several, so overriding the caller there would be wrong.
    //
    // It would NOT suit an Ollama-style upstream, which looks the name up strictly
    // and 404s on a miss. If we ever point at one, force cfg.model here instead.
    const payload = {
      ...body,
      model:
        typeof body.model === "string" && body.model ? body.model : cfg.model,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg["timeout-ms"]);
    // A client that hangs up should not leave us holding an upstream call.
    req.on("aborted", () => controller.abort());

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      // Only when there is one. A local llama-server wants no auth, and some
      // servers reject an empty bearer outright rather than ignoring it.
      if (cfg["api-key"]) headers.Authorization = `Bearer ${cfg["api-key"]}`;
      const resp = await fetch(cfg.url.replace(/\/+$/, ""), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await resp.text();
      res
        .status(resp.status)
        .type(resp.headers.get("content-type") || "application/json")
        .send(text);
    } catch (err: any) {
      const aborted = err?.name === "AbortError";
      const message = aborted
        ? `Embeddings upstream did not respond within ${cfg["timeout-ms"]}ms (${cfg.url})`
        : `Embeddings upstream call failed: ${err?.message || String(err)} (${cfg.url})`;
      console.error("[embeddings]", message);
      // 504 for a timeout, 502 otherwise — both say "the thing behind me failed",
      // which is materially different from auth2api itself being broken.
      res
        .status(aborted ? 504 : 502)
        .json({ error: { message, type: "upstream_error" } });
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Advertised on /v1/models so a client that enumerates before calling can find the
 * embedding model — but only when an upstream is actually usable. Advertising a
 * model that would 501 on use is worse than not advertising it at all.
 */
export function embeddingModelEntry(
  config: Config,
): Array<{ id: string; owned_by: string }> {
  const cfg = config.embeddings;
  if (!cfg?.enabled || !cfg.url) return [];
  return [{ id: cfg.model, owned_by: "auth2api-embeddings-proxy" }];
}
