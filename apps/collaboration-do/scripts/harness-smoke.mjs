#!/usr/bin/env node
/**
 * Hermetic happy-path verification for the two Plan 12 measurement CLIs.
 *
 * Starts the real Worker + Durable Object in a temporary local workerd,
 * drives the remote conformance runner through localhost HTTP/WebSocket, then
 * runs a short load sample and validates its machine-readable report. No
 * Cloudflare login, deployed Worker, persisted state, or production secret is
 * involved.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { unstable_startWorker } from "wrangler";

import { TEST_ROOM_TOKEN_SECRET } from "../tests/support/audit.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const environment = {
  ...process.env,
  COLLAB_JOIN_TOKEN_SECRET: TEST_ROOM_TOKEN_SECRET,
  COLLAB_SMOKE_ORIGIN: "http://localhost:3000",
};

const runNode = (script, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(packageRoot, script), ...args],
      {
        cwd: packageRoot,
        env: environment,
        stdio: "inherit",
      },
    );
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${script} exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${script} exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
        ),
      );
    });
  });

const assertSummary = (value, name) => {
  assert.equal(typeof value, "object", `${name} must be an object`);
  assert(value !== null, `${name} must not be null`);
  assert(Number.isInteger(value.count), `${name}.count must be an integer`);
  assert(value.count > 0, `${name}.count must be positive`);
  for (const key of ["p50", "p95", "p99", "max"]) {
    assert(Number.isFinite(value[key]), `${name}.${key} must be finite`);
  }
};

const assertLoadReport = (report) => {
  assert.equal(report.config.members, 2);
  assert.equal(report.config.editors, 1);
  assert.equal(report.config.mode, "sustained");
  assert.equal(report.config.receiverMode, "healthy");
  assert.equal(report.joined, 2);
  assert(Number.isFinite(report.measuredMs));
  assert(report.measuredMs >= 1_000);
  assertSummary(report.upgrade, "upgrade");
  assertSummary(report.joinAck, "joinAck");
  assert(report.scene.sent > 0, "scene.sent must be positive");
  assert(report.scene.received > 0, "scene.received must be positive");
  assert(report.presence.sent > 0, "presence.sent must be positive");
  assert(report.presence.received > 0, "presence.received must be positive");
  assertSummary(report.scene.latencyMs, "scene.latencyMs");
  assertSummary(report.presence.latencyMs, "presence.latencyMs");
  assert(Number.isFinite(report.scene.throughputPerS));
  assert(Number.isFinite(report.presence.throughputPerS));
  assert(Number.isFinite(report.fanoutAmplification));
  assert.deepEqual(report.upgradeRefusals, {});
  assert.equal(report.sendErrors, 0);
};

const temporaryDirectory = await mkdtemp(join(tmpdir(), "drawstuff-harness-"));
let worker;

try {
  worker = await unstable_startWorker({
    config: join(packageRoot, "wrangler.jsonc"),
    entrypoint: join(packageRoot, "src/index.ts"),
    bindings: {
      COLLAB_JOIN_TOKEN_SECRET: {
        type: "plain_text",
        value: TEST_ROOM_TOKEN_SECRET,
      },
    },
    dev: {
      inspector: false,
      logLevel: "error",
      persist: false,
      remote: false,
      server: { hostname: "127.0.0.1", port: 0 },
      structuredLogsHandler: () => {},
      watch: false,
    },
    sendMetrics: false,
  });
  await worker.ready;
  const baseUrl = (await worker.url).origin;
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);

  console.log(`harness-smoke: ephemeral Worker at ${baseUrl}`);
  await runNode("scripts/conformance-remote.mjs", [baseUrl], 120_000);

  const reportPath = join(temporaryDirectory, "load-report.json");
  await runNode(
    "scripts/loadtest.mjs",
    [
      baseUrl,
      "--members",
      "2",
      "--editors",
      "1",
      "--scene-hz",
      "2",
      "--presence-hz",
      "2",
      "--scene-bytes",
      "64",
      "--presence-bytes",
      "64",
      "--duration-s",
      "2",
      "--mode",
      "sustained",
      "--receiver-mode",
      "healthy",
      "--json",
      reportPath,
    ],
    30_000,
  );
  assertLoadReport(JSON.parse(await readFile(reportPath, "utf8")));
  console.log("harness-smoke OK: remote conformance + load report");
} finally {
  await worker?.dispose();
  await rm(temporaryDirectory, { force: true, recursive: true });
}
