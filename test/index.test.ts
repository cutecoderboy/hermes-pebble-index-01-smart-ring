import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const WORKER = "https://bridge.example.com";
const AUTH = "test-pebble-token";
const HERMES_URL = "https://hermes.test/webhooks/pebble";
const HERMES_SECRET = "test-hermes-secret";

// Tests run in the same isolate as the Worker, so stubbing globalThis.fetch
// intercepts the Worker's outbound call to Hermes (SELF.fetch is a service
// binding and is unaffected).
const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function mockHermes(respond: () => Promise<Response>): { captured: () => Captured } {
  let captured: Captured | undefined;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: String(input),
      body: String(init?.body),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
    return respond();
  });
  return {
    captured: () => {
      if (!captured) throw new Error("Hermes was never called");
      return captured;
    },
  };
}

afterEach(() => {
  vi.stubGlobal("fetch", realFetch);
  vi.unstubAllGlobals();
});

function pebbleForm(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

function post(body: FormData, headers: Record<string, string> = { Authorization: AUTH }) {
  return SELF.fetch(`${WORKER}/`, { method: "POST", body, headers });
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("routing", () => {
  it("serves a health check", async () => {
    const res = await SELF.fetch(`${WORKER}/health`);
    expect(res.status).toBe(200);
  });

  it("404s unknown paths", async () => {
    const res = await SELF.fetch(`${WORKER}/nope`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("405s non-POST on /", async () => {
    const res = await SELF.fetch(`${WORKER}/`);
    expect(res.status).toBe(405);
  });
});

describe("auth", () => {
  it("401s without an Authorization header", async () => {
    const res = await post(pebbleForm({ transcription: "hi" }), {});
    expect(res.status).toBe(401);
  });

  it("401s with a wrong token", async () => {
    const res = await post(pebbleForm({ transcription: "hi" }), { Authorization: "wrong" });
    expect(res.status).toBe(401);
  });

  it("accepts a Bearer-prefixed token", async () => {
    mockHermes(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await post(pebbleForm({ transcription: "hi", recordedAt: "1700000000000" }), {
      Authorization: `Bearer ${AUTH}`,
    });
    expect(res.status).toBe(200);
  });
});

describe("validation", () => {
  it("415s on a non-form body", async () => {
    const res = await SELF.fetch(`${WORKER}/`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  it("413s when the transcription exceeds the size cap", async () => {
    const res = await post(pebbleForm({ transcription: "x".repeat(64_001), recordedAt: "1700000000000" }));
    expect(res.status).toBe(413);
  });

  it("422s when transcription is missing, with a hint about Pebble settings", async () => {
    const res = await post(pebbleForm({ recordedAt: "1700000000000" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("transcription");
  });
});

describe("forwarding", () => {
  it("sends signed JSON to Hermes and returns 200", async () => {
    const hermes = mockHermes(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await post(
      pebbleForm({ transcription: "remind me to call mom at 5", recordedAt: "1700000000000", client: "ring" }),
    );
    expect(res.status).toBe(200);

    const { url, body, headers } = hermes.captured();
    expect(url).toBe(HERMES_URL);
    expect(headers["content-type"]).toBe("application/json");

    const payload = JSON.parse(body);
    expect(payload).toMatchObject({
      event_type: "pebble.recording",
      transcription: "remind me to call mom at 5",
      recorded_at_ms: 1700000000000,
      recorded_at: new Date(1700000000000).toISOString(),
      client: "ring",
    });

    const timestamp = headers["x-webhook-timestamp"];
    expect(Number(timestamp)).toBeGreaterThan(0);
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(60);
    const expected = await hmacSha256Hex(HERMES_SECRET, `${timestamp}.${body}`);
    expect(headers["x-webhook-signature-v2"]).toBe(expected);
    expect(headers["x-request-id"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same X-Request-ID for an identical recording (idempotency)", async () => {
    const first = mockHermes(async () => new Response("{}", { status: 200 }));
    await post(pebbleForm({ transcription: "same memo", recordedAt: "1700000000000" }));
    const firstId = first.captured().headers["x-request-id"];

    const second = mockHermes(async () => new Response("{}", { status: 200 }));
    await post(pebbleForm({ transcription: "same memo", recordedAt: "1700000000000" }));
    expect(second.captured().headers["x-request-id"]).toBe(firstId);
  });

  it("502s when Hermes rejects the request", async () => {
    mockHermes(async () => new Response("nope", { status: 500 }));
    const res = await post(pebbleForm({ transcription: "hi", recordedAt: "1700000000000" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("500");
  });

  it("502s when Hermes is unreachable", async () => {
    mockHermes(async () => {
      throw new TypeError("connect failed");
    });
    const res = await post(pebbleForm({ transcription: "hi", recordedAt: "1700000000000" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unreachable");
  });
});
