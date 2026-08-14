import { connect as netConnect, type Socket } from "node:net";

/**
 * A WebSocket connection that will never complete a close handshake: the
 * upgrade is performed by hand and every relay frame after it — including any
 * close frame the relay sends — is read and ignored. This is the socket the
 * bounded force-terminate deadlines (drain window, capacity-refusal grace)
 * exist for.
 *
 * @param registerCleanup Receives a destroyer the caller must run in its test
 * cleanup; the socket outlives the returned promise.
 */
export const openUnresponsiveSocket = (
  port: number,
  registerCleanup: (cleanup: () => void) => void,
): Promise<Socket> => {
  const socket = netConnect(port, "127.0.0.1");
  registerCleanup(() => {
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("data", () => resolve(socket));
    socket.write(
      [
        "GET / HTTP/1.1",
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    socket.on("data", () => {
      // Swallow everything, answer nothing.
    });
  });
};
