# hermes-pebble-index-01-smart-ring

Speak into your [Pebble Index 01](https://repebble.com/index) ring; your self-hosted [Hermes Agent](https://github.com/NousResearch/hermes-agent) figures out whether it's a **reminder, task, search, or note** — and acts on it.

This repo is a tiny Cloudflare Worker that bridges the two: the Pebble app's webhook speaks `multipart/form-data`, Hermes's webhook gateway expects HMAC-signed JSON. The Worker authenticates the ring, translates the payload, signs it, and forwards it to Hermes running on your own machine.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zmh/hermes-pebble-index-01-smart-ring)

```
┌───────────┐ BLE ┌────────────┐ HTTPS multipart ┌────────────────────┐ signed JSON ┌──────────────────────┐
│ Index 01  │────▶│ Pebble app │────────────────▶│ Cloudflare Worker  │────────────▶│ Hermes on your Mac/  │
│ (ring)    │     │ (phone)    │  + auth token   │ (this repo)        │  HMAC-SHA256│ home server, via     │
└───────────┘     └────────────┘                 └────────────────────┘             │ Tailscale Funnel or  │
                                                                                    │ Cloudflare Tunnel    │
                                                                                    └──────────────────────┘
```

The Worker is deliberately dumb — no LLM calls, no storage, no logging of your words. All the intelligence (classifying the memo, creating the reminder, running the task, saving the note) lives in Hermes, where your memory, skills, and tools already are. If Hermes is unreachable, the Worker returns an error and the recording stays safely in the Pebble app.

## Setup

Three parts: deploy the Worker, expose Hermes, configure the Pebble app.

### 1. Deploy the Worker

Click the **Deploy to Cloudflare** button above (or `npm install && npx wrangler deploy`). You'll be prompted for three secrets:

| Secret | What it is |
|---|---|
| `PEBBLE_AUTH_TOKEN` | Any long random string; the Pebble app will send it as its `Authorization` header. Generate one: `openssl rand -hex 32` |
| `HERMES_URL` | Full public URL of your Hermes webhook route, e.g. `https://mini.tailXXXX.ts.net/webhooks/pebble` (set up in step 2) |
| `HERMES_WEBHOOK_SECRET` | Another random string; must match the `secret` on the Hermes route. Generate a second one: `openssl rand -hex 32` |

To set them later: `npx wrangler secret put PEBBLE_AUTH_TOKEN` (etc.).

### 2. Expose Hermes on your machine

See **[docs/hermes-setup.md](docs/hermes-setup.md)** for the full walkthrough: the Hermes `config.yaml` webhook route (including the classification prompt), plus exposing port 8644 publicly with **Tailscale Funnel** (recommended if you already run Tailscale) or **Cloudflare Tunnel**.

### 3. Point the Pebble app at the Worker

In the Pebble app's **Index** tab → webhook settings ([Pebble's docs](https://help.repebble.com/en/articles/15724406-index-advanced-features-mcp-webhook)):

- **URL**: your Worker URL, e.g. `https://hermes-pebble-index-01-smart-ring.<your-subdomain>.workers.dev`
- **Headers**: add `Authorization` with the value of `PEBBLE_AUTH_TOKEN`
- **Send**: transcription (this bridge ignores audio by design)
- **Trigger**: pick which button combo fires the webhook

Record a memo — "remind me to water the plants tomorrow at 9" — and watch Hermes act on it.

## What the Worker sends Hermes

```json
{
  "event_type": "pebble.recording",
  "transcription": "remind me to water the plants tomorrow at 9",
  "recorded_at": "2026-08-23T21:14:05.000Z",
  "recorded_at_ms": 1787822045000,
  "client": "ring"
}
```

with headers `X-Webhook-Timestamp`, `X-Webhook-Signature-V2` (hex HMAC-SHA256 of `<timestamp>.<body>`, Hermes's Generic V2 scheme with ±300s replay protection), and a deterministic `X-Request-ID` (SHA-256 of `recordedAt:transcription`) so retries deduplicate on the Hermes side.

## Local development

```sh
npm install
npm test                                   # vitest (Workers runtime)

# End-to-end without a real Hermes:
cp .dev.vars.example .dev.vars             # fill in values; point HERMES_URL at http://localhost:8644/webhooks/pebble
HERMES_WEBHOOK_SECRET=<same-secret> npm run mock-hermes   # terminal 1: fake Hermes that verifies signatures
npm run dev                                               # terminal 2: the Worker

curl -X POST http://localhost:8787/ \
  -H "Authorization: <PEBBLE_AUTH_TOKEN>" \
  -F "transcription=this is a test note" \
  -F "recordedAt=$(date +%s)000" \
  -F "client=ring"
```

## Security notes

- The Worker rejects anything without your `PEBBLE_AUTH_TOKEN` (constant-time comparison), so random internet traffic never reaches Hermes.
- Hermes independently verifies the HMAC signature and timestamp, so even if your tunnel URL leaks, unsigned requests are dropped.
- Giving the Hermes route an elevated toolset (so it can actually create reminders, run tasks, etc.) is reasonable *because* of that signature — but it means anyone holding both secrets can drive your agent. Treat them like passwords.
- The Worker logs only status codes and latency, never transcription contents.
- The Worker caps transcriptions at 64K characters, so a leaked Pebble token can't be used to push huge payloads downstream.

### The microphone is an attack surface

Think carefully about what this pipeline *is*: anything your ring transcribes becomes instructions to an agent that may have terminal access. That includes garbled speech-to-text, other people talking near you mid-recording, or someone who grabs your ring — the trust boundary is physical possession of the ring plus the button press, not your voice.

The recommended route prompt in [docs/hermes-setup.md](docs/hermes-setup.md) mitigates this by telling Hermes to treat the transcription as untrusted: destructive or hard-to-reverse actions (deleting things, sending money or messages, changing settings) are never executed directly from a memo — the agent instead asks for confirmation on your messaging channel. But prompt guardrails are best-effort. The real controls are the `toolsets` you grant the route (grant the minimum you need) and keeping the two secrets secret.

## Ideas / not yet implemented

- Store audio in R2 and let Hermes re-transcribe garbled memos
- Buffer-and-retry (KV or Durable Object) when the home machine is asleep
- Multiple routes per button combo (Pebble currently supports a single webhook)

PRs welcome. MIT licensed.
