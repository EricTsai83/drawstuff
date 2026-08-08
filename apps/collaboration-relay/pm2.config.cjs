/**
 * Deployment envelope for the collaboration relay.
 *
 * Single instance in fork mode is an approved architectural decision, not a
 * default left in place: the fanout's room state is process-local, and SLO §0
 * (docs/performance/collaboration-slo-capacity.md) records the 2026-08-06
 * decision — matching upstream `excalidraw-room` — not to support horizontal
 * scaling. Raising `instances` or switching to cluster mode would silently
 * split rooms across processes; it requires a new approved decision first.
 *
 * Operating procedures, capacity and the availability ceiling are documented
 * in docs/operations/collaboration-relay-deployment.md.
 */
module.exports = {
  apps: [
    {
      name: "collaboration-relay",
      cwd: __dirname,
      script: "src/main.ts",
      // Same launch contract as `pnpm start`.
      interpreter: "node",
      interpreter_args: "--import tsx",
      exec_mode: "fork",
      instances: 1,
      // pm2 escalates its stop signal to SIGKILL after this deadline. It must
      // exceed the relay's drain window (`drainTimeoutMs`, 10 s) plus close
      // time, or every restart would cut the graceful drain short and turn it
      // back into the mass disconnect it exists to prevent.
      kill_timeout: 15000,
      // Deliberately NO `max_memory_restart`: pm2's version is a hard kill.
      // The relay runs its own max-memory watchdog (src/watchdog.ts, SLO §4.1,
      // 1 GiB) that drains first and then exits non-zero; `autorestart`
      // brings the process back either way.
      autorestart: true,
      env: {
        HOST: "127.0.0.1",
        PORT: "3005",
        // COLLAB_JOIN_TOKEN_SECRET must come from the host environment; the
        // relay refuses to start without it.
      },
    },
  ],
};
