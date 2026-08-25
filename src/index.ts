/**
 * Pebble Index 01 → Hermes bridge.
 *
 * Receives the Pebble app's webhook (multipart/form-data) and forwards the
 * transcription to a Hermes Agent webhook route as HMAC-signed JSON.
 *
 * Pebble sends:  transcription (text), recordedAt (ms epoch), client ('ring'),
 *                optionally audio (audio/mp4) — ignored here by design.
 * Hermes wants:  JSON body, X-Webhook-Signature-V2 = hex HMAC-SHA256 of
 *                "<timestamp>.<body>", X-Webhook-Timestamp = unix seconds.
 */

export interface Env {
  /** Token the Pebble app sends in its Authorization header. */
  PEBBLE_AUTH_TOKEN: string;
  /** Full URL of the Hermes webhook route, e.g. https://mini.tailXXXX.ts.net/webhooks/pebble */
  HERMES_URL: string;
  /** HMAC key matching the `secret` on the Hermes route. */
  HERMES_WEBHOOK_SECRET: string;
}

const HERMES_TIMEOUT_MS = 10_000;

// Far above any real voice memo (~1KB/min of speech), far below Hermes's 1MB
// body cap. Bounds what a leaked Pebble token can push downstream.
const MAX_TRANSCRIPTION_CHARS = 64_000;

const encoder = new TextEncoder();

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

/** Accepts the raw token or "Bearer <token>", since the Pebble app takes a freeform header value. */
function isAuthorized(header: string | null, token: string): boolean {
  if (!header) return false;
  return timingSafeEqual(header, token) || timingSafeEqual(header, `Bearer ${token}`);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(sig);
}

async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(message)));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json(200, { ok: true });
    }
    if (url.pathname !== "/") {
      return json(404, { ok: false, error: "not found" });
    }
    if (request.method !== "POST") {
      return json(405, { ok: false, error: "method not allowed; POST /" });
    }

    const missing = (["PEBBLE_AUTH_TOKEN", "HERMES_URL", "HERMES_WEBHOOK_SECRET"] as const).filter(
      (name) => !env[name],
    );
    if (missing.length > 0) {
      return json(500, { ok: false, error: `worker misconfigured: missing secrets ${missing.join(", ")}` });
    }

    if (!isAuthorized(request.headers.get("Authorization"), env.PEBBLE_AUTH_TOKEN)) {
      return json(401, { ok: false, error: "unauthorized" });
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json(415, { ok: false, error: "expected multipart/form-data (Pebble webhook format)" });
    }

    const transcription = form.get("transcription");
    if (typeof transcription !== "string" || transcription.trim() === "") {
      return json(422, {
        ok: false,
        error:
          "no transcription in payload — in the Pebble app's webhook settings, enable sending the transcription (this bridge ignores audio)",
      });
    }

    if (transcription.length > MAX_TRANSCRIPTION_CHARS) {
      return json(413, { ok: false, error: `transcription too large (max ${MAX_TRANSCRIPTION_CHARS} characters)` });
    }

    const recordedAtRaw = form.get("recordedAt");
    const recordedAtMs =
      typeof recordedAtRaw === "string" && /^\d+$/.test(recordedAtRaw) ? Number(recordedAtRaw) : Date.now();
    const client = typeof form.get("client") === "string" ? (form.get("client") as string) : "unknown";

    const body = JSON.stringify({
      event_type: "pebble.recording",
      transcription,
      recorded_at: new Date(recordedAtMs).toISOString(),
      recorded_at_ms: recordedAtMs,
      client,
    });

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const [signature, requestId] = await Promise.all([
      hmacSha256Hex(env.HERMES_WEBHOOK_SECRET, `${timestamp}.${body}`),
      sha256Hex(`${recordedAtMs}:${transcription}`),
    ]);

    const started = Date.now();
    let upstream: Response;
    try {
      upstream = await fetch(env.HERMES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Timestamp": timestamp,
          "X-Webhook-Signature-V2": signature,
          "X-Request-ID": requestId,
        },
        body,
        signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "unreachable";
      console.log(JSON.stringify({ event: "forward_failed", reason, ms: Date.now() - started }));
      return json(502, { ok: false, error: `hermes ${reason} — recording is retained in the Pebble app` });
    }

    // Never log transcription contents; status + latency only.
    console.log(JSON.stringify({ event: "forwarded", status: upstream.status, ms: Date.now() - started }));

    if (!upstream.ok) {
      return json(502, {
        ok: false,
        error: `hermes rejected the webhook (HTTP ${upstream.status}) — check route secret and config`,
      });
    }
    return json(200, { ok: true });
  },
} satisfies ExportedHandler<Env>;
