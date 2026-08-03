import { createRelayServer } from "./server.ts";

/**
 * Local/test entry point (Plan 12). Production deployment, authentication,
 * and multi-instance fanout are out of scope until Plans 13/19.
 */
const port = Number(process.env.PORT ?? "3005");
const host = process.env.HOST ?? "127.0.0.1";

const server = await createRelayServer({ port, host });
// The cross-process integration test parses this line to learn the port.
console.log(`collaboration-relay listening on ${server.url}`);

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
