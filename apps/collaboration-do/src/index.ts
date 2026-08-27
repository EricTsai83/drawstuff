import { handleGatewayRequest } from "./gateway.ts";
import { pingControlOutboxDrain } from "./outbox-drain.ts";
import { CollaborationRoom } from "./room.ts";

// The Durable Object class ships in the same bundle as the gateway
// (CLAIM-MIG-3) and must stay listed in wrangler.jsonc `exports`.
export { CollaborationRoom };

export default {
  fetch(request, env) {
    return handleGatewayRequest(request, env);
  },
  // Minute cron (wrangler.jsonc `triggers`): pings the web app's control
  // outbox drain endpoint. See ./outbox-drain.ts for why the clock lives here.
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(pingControlOutboxDrain(env));
  },
} satisfies ExportedHandler<Env>;
