import { execFileSync, spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import crypto from "node:crypto";

const container = `drawstuff-p0-${crypto.randomUUID()}`;
const password = crypto.randomBytes(24).toString("hex");
const load = process.argv.includes("--load");
const report = load ? `/tmp/${container}-load.json` : undefined;
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
      "POSTGRES_DB=drawstuff_p0",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "postgres:17-alpine",
    ],
    { stdio: ["ignore", "ignore", "inherit"], timeout: 120_000 },
  );
  let ready = false;
  if (interrupted) throw new Error("fixture interrupted");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (interrupted) throw new Error("fixture interrupted");
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
  if (!ready) throw new Error("PostgreSQL fixture did not become ready");
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
      "vitest.p0.config.ts",
      "--reporter",
      "verbose",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        COLLAB_P0_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${port}/drawstuff_p0`,
        ...(report ? { COLLAB_P0_REPORT: report } : {}),
      },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} catch {
  console.error(
    "P0 fixture failed; check Docker availability and the test output above",
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
