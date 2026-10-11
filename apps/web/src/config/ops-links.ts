/**
 * Where operators read the logs the admin console does not hold. Links, not
 * an API integration: the console mirrors what needs action into Neon (Needs
 * attention), and reading raw logs stays in each platform's own dashboard,
 * behind its own sign-in, so no log-reading credential lives in this app.
 */
export const OPS_LOG_LINKS = {
  /** Collaboration Worker and Durable Objects (`collaboration-do-observability.md`). */
  durableObjects:
    "https://dash.cloudflare.com/?to=/:account/workers/services/view/drawstuff-collaboration-do/production/observability/events",
  /** Web app runtime logs, e.g. `cleanup.deferred_failed`. */
  web: "https://vercel.com/erictsai83s-projects/drawstuff/logs",
} as const;
