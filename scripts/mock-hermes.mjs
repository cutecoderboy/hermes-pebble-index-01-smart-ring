// Minimal stand-in for a Hermes webhook route, for local end-to-end testing.
// Verifies the V2 signature the same way Hermes does, then prints the payload.
//
//   HERMES_WEBHOOK_SECRET=dev-secret node scripts/mock-hermes.mjs
//
// Then run `wrangler dev` with .dev.vars pointing HERMES_URL at
// http://localhost:8644/webhooks/pebble and the same secret.

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8644);
const SECRET = process.env.HERMES_WEBHOOK_SECRET ?? "dev-secret";

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const timestamp = req.headers["x-webhook-timestamp"];
    const signature = req.headers["x-webhook-signature-v2"];

    const expected = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
    const valid =
      typeof signature === "string" &&
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300;

    console.log(`\n[mock-hermes] ${req.method} ${req.url}`);
    console.log(`[mock-hermes] signature ${valid ? "VALID" : "INVALID"}, timestamp ${fresh ? "fresh" : "STALE"}`);
    console.log(`[mock-hermes] X-Request-ID: ${req.headers["x-request-id"]}`);
    try {
      console.log("[mock-hermes] payload:", JSON.stringify(JSON.parse(body), null, 2));
    } catch {
      console.log("[mock-hermes] raw body:", body);
    }

    res.writeHead(valid && fresh ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: valid && fresh }));
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-hermes] listening on http://localhost:${PORT}/webhooks/pebble (secret: ${SECRET})`);
});
