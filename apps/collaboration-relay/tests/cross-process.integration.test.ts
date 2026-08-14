import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { roomIdSchema } from "@drawstuff/collaboration/protocol";

import { TEST_ROOM_TOKEN_SECRET } from "./support/room-tokens.ts";
import { createTestClient, waitUntil } from "./support/test-client.ts";

/**
 * Plan 12 outcome check: two collaboration clients in different OS processes
 * exchange scene messages through a relay that itself runs in a third
 * process. The relay child runs the real `src/main.ts` entry point.
 */

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const ROOM_ID = roomIdSchema.parse("room-cross-process");

const children: ChildProcess[] = [];
afterEach(() => {
  while (children.length > 0) {
    children.pop()?.kill("SIGTERM");
  }
});

type LineStream = {
  child: ChildProcess;
  /** Resolves with the first line matching the predicate, ever seen. */
  waitForLine(
    predicate: (line: string) => boolean,
    description: string,
  ): Promise<string>;
  lines(): readonly string[];
  /** Set once the process has exited; how it did is in the string. */
  exitStatus(): string | undefined;
};

function spawnTsx(script: string, env: Record<string, string>): LineStream {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  const seenLines: string[] = [];
  const stderrChunks: string[] = [];
  let exited: string | undefined;
  let buffered = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    seenLines.push(...lines.filter((line) => line.length > 0));
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderrChunks.push(chunk));
  child.on("exit", (code, signal) => {
    exited = `exit code=${code} signal=${signal}`;
  });

  return {
    child,
    async waitForLine(predicate, description) {
      await waitUntil(
        () => seenLines.some(predicate) || exited !== undefined,
        description,
      );
      const line = seenLines.find(predicate);
      if (!line) {
        throw new Error(
          `${script} died before "${description}" (${exited}): ${stderrChunks.join("")}`,
        );
      }
      return line;
    },
    lines: () => seenLines,
    exitStatus: () => exited,
  };
}

/** Spawns the real relay entry point and resolves its listening URL. */
async function spawnRelay(port: string): Promise<{
  relay: LineStream;
  url: string;
}> {
  const relay = spawnTsx(path.join("src", "main.ts"), {
    PORT: port,
    HOST: "127.0.0.1",
    // The relay process refuses to start without the shared token secret,
    // so the real startup contract is exercised here too.
    COLLAB_JOIN_TOKEN_SECRET: TEST_ROOM_TOKEN_SECRET,
  });
  // The relay logs JSON lines (Plan 24), so the port is read out of the
  // structured `relay.listening` record rather than out of prose.
  const listeningLine = await relay.waitForLine(
    (line) => line.includes(`"event":"relay.listening"`),
    "relay process to start listening",
  );
  const { url } = JSON.parse(listeningLine) as { url?: string };
  if (!url) throw new Error("relay did not report its url");
  return { relay, url };
}

describe("cross-process relay integration", () => {
  it("reports a bind failure as a structured record and exits nonzero", async () => {
    // Plan 07 L2: EADDRINUSE used to escape as a raw stack on stderr,
    // violating the "logger is the only output" contract. The startup path now
    // reports it through the same structured sink as every other record.
    const { url } = await spawnRelay("0");
    const port = new URL(url).port;

    const duplicate = spawnTsx(path.join("src", "main.ts"), {
      PORT: port,
      HOST: "127.0.0.1",
      COLLAB_JOIN_TOKEN_SECRET: TEST_ROOM_TOKEN_SECRET,
    });
    const failedLine = await duplicate.waitForLine(
      (line) => line.includes(`"event":"relay.startup_failed"`),
      "the structured bind-failure record",
    );
    expect(JSON.parse(failedLine)).toMatchObject({
      level: "error",
      port: Number(port),
    });
    await waitUntil(
      () => duplicate.exitStatus() !== undefined,
      "the duplicate process to exit",
    );
    expect(duplicate.exitStatus()).toBe("exit code=1 signal=null");
  });

  it("converges clients in different processes through a relay process", async () => {
    const { url } = await spawnRelay("0");

    const driver = spawnTsx(path.join("tests", "support", "client-driver.ts"), {
      RELAY_URL: url,
      RELAY_ROOM_ID: ROOM_ID,
      RELAY_CLIENT_NAME: "client-driver",
      RELAY_NONCE_SEED: "9",
      RELAY_ELEMENT_PREFIX: "el-driver",
      RELAY_ELEMENT_COUNT: "3",
    });
    await driver.waitForLine(
      (line) => line === "ready",
      "driver process to join the room",
    );

    const local = await createTestClient({
      url,
      roomId: ROOM_ID,
      clientName: "client-local",
      nonceSeed: 1,
    });
    try {
      await local.connect();
      local.upsertElement("el-local-0", "from-local");
      local.upsertElement("el-local-1", "from-local");

      // Convergence: the driver's last reported digest equals ours and both
      // contain the union of elements created in the two client processes.
      await waitUntil(
        () => {
          const lastDigest = driver
            .lines()
            .filter((line) => line.startsWith("digest\t"))
            .at(-1)
            ?.slice("digest\t".length);
          return lastDigest !== undefined && lastDigest === local.digest();
        },
        "cross-process digests to converge",
        20_000,
      );

      expect(local.elementIds()).toEqual([
        "el-driver-0",
        "el-driver-1",
        "el-driver-2",
        "el-local-0",
        "el-local-1",
      ]);
    } finally {
      local.close();
    }
  });

  it("drains on SIGTERM so every client retryably disconnects and rejoins the replacement", async () => {
    const { relay, url } = await spawnRelay("0");
    // The deployment envelope's startup declaration (Plan 25) comes from the
    // real entry point, so this is where it is observable.
    await relay.waitForLine(
      (line) =>
        line.includes(`"event":"relay.single_instance"`) &&
        line.includes(`"instances":1`),
      "the single-instance declaration",
    );
    const port = new URL(url).port;

    const a = await createTestClient({
      url,
      roomId: ROOM_ID,
      clientName: "client-drain-a",
      nonceSeed: 3,
    });
    const b = await createTestClient({
      url,
      roomId: ROOM_ID,
      clientName: "client-drain-b",
      nonceSeed: 4,
    });
    try {
      await a.connect();
      await b.connect();
      a.upsertElement("el-pre-drain", "before");
      await waitUntil(
        () => a.digest() === b.digest() && b.elementIds().length === 1,
        "pre-drain convergence",
      );

      relay.child.kill("SIGTERM");
      await a.waitForDisconnect();
      await b.waitForDisconnect();
      // Retryable, not terminal: the transport read the drain's close code as
      // a transient condition, which is what recovery retries through.
      expect(a.connectionState()).toEqual({
        status: "disconnected",
        reason: "transient",
      });
      expect(b.connectionState()).toEqual({
        status: "disconnected",
        reason: "transient",
      });

      // The drain ended inside its window with nothing left to force, and the
      // ordered shutdown exited cleanly.
      const drainedLine = await relay.waitForLine(
        (line) => line.includes(`"event":"relay.drained"`),
        "the drain completion record",
      );
      expect(JSON.parse(drainedLine)).toMatchObject({
        connections: 2,
        forcedTerminations: 0,
      });
      await waitUntil(
        () => relay.exitStatus() !== undefined,
        "the drained relay process to exit",
      );
      expect(relay.exitStatus()).toBe("exit code=0 signal=null");

      // The replacement process binds the same address; the same clients
      // rejoin it and converge on new edits.
      await spawnRelay(port);
      await a.connect();
      await b.connect();
      b.upsertElement("el-post-drain", "after");
      await waitUntil(
        () => a.digest() === b.digest() && a.elementIds().length === 2,
        "post-drain convergence on the replacement process",
        20_000,
      );
      expect(a.elementIds()).toEqual(["el-post-drain", "el-pre-drain"]);
    } finally {
      a.close();
      b.close();
    }
  });
});
