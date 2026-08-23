#!/usr/bin/env node
/**
 * Live smoke for a deployed collaboration DO gateway (Plan 09 evidence).
 *
 * Probes only closed-response behavior reachable with plain fetch: healthz
 * readiness, unknown-route/method/content-type/body handling. The full
 * contract matrix (Origin allowlist, header stripping, DO identity) is owned
 * by the workerd test suite; this script proves the *deployed* Worker answers
 * with the same surface, and prints the version id for the deploy record.
 *
 * Usage:
 *   pnpm --filter @drawstuff/collaboration-do smoke <base-url>
 *   e.g. pnpm --filter @drawstuff/collaboration-do smoke \
 *     https://drawstuff-collaboration-do-staging.<subdomain>.workers.dev
 */

const base = process.argv[2];
if (!base) {
  console.error("usage: pnpm smoke <base-url>");
  process.exit(2);
}
const target = base.replace(/\/+$/, "");

let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}: ${error.message}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

await check("healthz is ok and reports version metadata", async () => {
  const response = await fetch(`${target}/healthz`);
  expect(response.status === 200, `status ${response.status}`);
  const body = await response.json();
  console.log(
    `      version=${body?.version?.id ?? "?"} ready=${JSON.stringify(body?.ready)}`,
  );
  expect(
    body.ok === true,
    `ok=${String(body.ok)} — secret or origin allowlist not ready`,
  );
});

await check("unknown route closes with 404", async () => {
  const response = await fetch(`${target}/metrics`);
  expect(response.status === 404, `status ${response.status}`);
});

await check("socket route without Upgrade closes with 426", async () => {
  const response = await fetch(
    `${target}/v1/rooms/smoke-room/generations/1/socket`,
  );
  expect(response.status === 426, `status ${response.status}`);
});

await check("malformed socket identity closes with 404", async () => {
  const response = await fetch(
    `${target}/v1/rooms/smoke-room/generations/01/socket`,
  );
  expect(response.status === 404, `status ${response.status}`);
});

await check("control refuses non-POST with 405", async () => {
  const response = await fetch(`${target}/v1/control`);
  expect(response.status === 405, `status ${response.status}`);
});

await check("control refuses non-JSON content type with 415", async () => {
  const response = await fetch(`${target}/v1/control`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "token=x",
  });
  expect(response.status === 415, `status ${response.status}`);
});

await check("control closes malformed JSON with 400", async () => {
  const response = await fetch(`${target}/v1/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  expect(response.status === 400, `status ${response.status}`);
});

await check("control rejects an unsigned token with 401", async () => {
  const response = await fetch(`${target}/v1/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "smoke.smoke" }),
  });
  expect(response.status === 401, `status ${response.status}`);
});

if (failures > 0) {
  console.error(`\nsmoke FAILED (${failures})`);
  process.exit(1);
}
console.log("\nsmoke OK");
