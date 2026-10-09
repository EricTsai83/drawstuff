import { handleGatewayRequest } from "./gateway.ts";
import { CollaborationLifecycle } from "./lifecycle.ts";
import { CollaborationRoomV2 } from "./room.ts";

// The Durable Object class ships in the same bundle as the gateway
// (CLAIM-MIG-3) and must stay listed in wrangler.jsonc `exports`.
export { CollaborationRoomV2, CollaborationLifecycle };

export default {
  fetch(request, env) {
    return handleGatewayRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
