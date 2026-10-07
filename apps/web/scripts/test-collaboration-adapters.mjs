import { execFileSync, spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { randomBytes, randomUUID } from "node:crypto";

// Disposable local PostgreSQL only. Never read an application's configured database URI.
const container = `drawstuff-adapters-${randomUUID()}`;
const password = randomBytes(24).toString("hex");
let child;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  child?.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_DB=drawstuff_adapters",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "postgres:17-alpine",
    ],
    { stdio: ["ignore", "ignore", "inherit"], timeout: 120_000 },
  );
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (interrupted) throw new Error("interrupted");
    try {
      execFileSync(
        "docker",
        ["exec", container, "pg_isready", "-U", "postgres"],
        { stdio: "ignore" },
      );
      ready = true;
      break;
    } catch {
      await setTimeout(500);
    }
  }
  if (!ready || interrupted) throw new Error("fixture-unavailable");
  const port = execFileSync("docker", ["port", container, "5432"], {
    encoding: "utf8",
  })
    .trim()
    .split(":")
    .at(-1);
  child = spawn(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.adapters.config.ts",
      "--reporter",
      "verbose",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        COLLAB_ADAPTER_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${port}/drawstuff_adapters`,
      },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} catch {
  console.error(
    "Adapter PostgreSQL fixture failed; check Docker availability and the test output above",
  );
  process.exitCode = 1;
} finally {
  try {
    execFileSync("docker", ["rm", "--force", "--volumes", container], {
      stdio: "ignore",
    });
  } catch {
    /* Container may not have started. */
  }
}
