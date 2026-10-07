import { CollaborationRoom as MaintenanceRoom } from "../../src/maintenance.ts";
export { default, CollaborationLifecycle } from "../../src/maintenance.ts";

/** Test-only socket setup. Never included in a deployment config. */
export class CollaborationRoom extends MaintenanceRoom {
  override fetch(request: Request): Response | Promise<Response> {
    if (new URL(request.url).pathname !== "/seed") return super.fetch(request);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
