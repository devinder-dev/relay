// Checks the receiver inside the production image with a signed body and a tampered body.
const signingPath = "/app/src/worker/sign.ts";
const { buildBody, signatureHeaders } = await import(signingPath);
const [url, secret] = process.argv.slice(2);
if (!url || !secret) throw new Error("Receiver smoke test needs its URL and a test secret");

// Step 1: import the image's actual signer; the mounted script carries no implementation copy.
const body = buildBody({ type: "demo.ping", createdAt: new Date(), payload: {} });
const headers = signatureHeaders({ secret, eventId: crypto.randomUUID(), body, nowSeconds: Date.now() / 1000 });
for (const [payload, expected] of [[body, 200], [Buffer.concat([body, Buffer.from(" ")]), 401]] as const) {
  const response = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(5000) });
  if (response.status !== expected) throw new Error(`Receiver answered ${response.status}, expected ${expected}`);
}
console.log("✅ receiver verifies the image's signed bytes and rejects a changed body");
