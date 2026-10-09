/** Hermetic CLI fixture only. Production entrypoint never imports this module. */
import worker, {
  CollaborationRoomV2,
  CollaborationLifecycle,
} from "../../src/index.ts";
import {
  adapterCommandSchema,
  ADAPTER_METADATA_HEADER,
  SNAPSHOT_RECEIPT_HEADER,
} from "@drawstuff/collaboration/authority";

const originalFetch = globalThis.fetch;
type StoredRoom = {
  epoch: number;
  state: string;
  revision: number;
  snapshot?: Uint8Array;
  checksum?: string;
  assets: Map<
    string,
    {
      excalidrawFileId: string;
      byteLength: number;
      url: string;
    }
  >;
};
const rooms = new Map<string, StoredRoom>();
const receipts = new Map<string, unknown>();
const registrations = new Map<string, Set<string>>();
const freezes = new Map<string, number>();
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).hostname !== "fixture-adapter.test")
    return originalFetch(input, init);
  const metadata = request.headers.get(ADAPTER_METADATA_HEADER);
  const command = adapterCommandSchema.parse(
    metadata ? (JSON.parse(metadata) as unknown) : await request.json(),
  );
  const json = (value: unknown) => Response.json(value);
  if (command.action === "register") {
    if (freezes.has(command.identity.subject)) return json({ error: "frozen" });
    const registered =
      registrations.get(command.identity.subject) ?? new Set<string>();
    registered.add(command.roomId);
    registrations.set(command.identity.subject, registered);
    return json({
      roomId: command.roomId,
      operationId: command.operationId,
      subject: command.identity.subject,
      lifecycleVersion: command.identity.lifecycleVersion,
    });
  }
  if (command.action === "create-parent") {
    rooms.set(command.roomId, {
      epoch: 1,
      state: "initializing",
      revision: 0,
      assets: new Map(),
    });
    return json({
      roomId: command.roomId,
      createOperationId: command.createOperationId,
    });
  }
  if (command.action === "project" || command.action === "project-invite")
    return json({ applied: true });
  if (command.action === "lifecycle-freeze") {
    freezes.set(command.command.target.subject, 2);
    return json({ version: 2 });
  }
  if (command.action === "lifecycle-list")
    return json({
      version: 2,
      rooms: [...(registrations.get(command.command.target.subject) ?? [])].map(
        (roomId) => ({ roomId, action: "end-room" }),
      ),
      cursor: null,
    });
  if (command.action === "lifecycle-delete") return json({ deleted: true });
  if (
    command.action === "write" ||
    command.action === "query" ||
    command.action === "cancel"
  ) {
    const operation = command.operation;
    const prior = receipts.get(operation.operationId);
    if (prior) return json(prior);
    if (command.action === "query") return json({ status: "pending" });
    if (command.action === "cancel") {
      const receipt = { status: "cancelled" };
      receipts.set(operation.operationId, receipt);
      return json(receipt);
    }
    const room = rooms.get(operation.roomId);
    if (room?.epoch !== operation.authorityEpoch || room.state === "ended")
      return json({ status: "refused" });
    if (operation.asset) {
      const { utFileKey, ...asset } = operation.asset;
      void utFileKey;
      room.assets.set(asset.excalidrawFileId, asset);
    } else {
      if (room.revision !== operation.expectedRevision)
        return json({ status: "conflict" });
      room.revision++;
      room.snapshot = metadata
        ? new Uint8Array(await request.arrayBuffer())
        : undefined;
      room.checksum = operation.checksum;
    }
    const receipt = {
      status: "written",
      revision: operation.asset ? 1 : room.revision,
    };
    receipts.set(operation.operationId, receipt);
    return json(receipt);
  }
  if (!("roomId" in command)) throw new Error("unexpected-fixture-command");
  const room = rooms.get(command.roomId);
  if (command.action === "fence") {
    if (!room)
      rooms.set(command.roomId, {
        epoch: command.authorityEpoch,
        state: command.state,
        revision: 0,
        assets: new Map(),
      });
    else {
      room.epoch = command.authorityEpoch;
      room.state = command.state;
    }
    return json({ authorityEpoch: command.authorityEpoch });
  }
  if (!room) throw new Error("missing-fixture-room");
  if (command.action === "cleanup") {
    room.assets.clear();
    room.snapshot = undefined;
    return json({ cleaned: true });
  }
  if (command.action === "read-assets")
    return json({
      assets: command.assetIds.flatMap((id) => {
        const asset = room.assets.get(id);
        return asset
          ? [
              {
                excalidrawFileId: asset.excalidrawFileId,
                byteLength: asset.byteLength,
                url: asset.url,
              },
            ]
          : [];
      }),
    });
  if (command.action === "verify-initialization") {
    if (
      !room.snapshot ||
      room.revision !== command.manifest.revision ||
      room.checksum !== command.manifest.checksum ||
      command.manifest.assetIds.some((id) => !room.assets.has(id))
    )
      throw new Error("incomplete");
    return json({ manifest: command.manifest });
  }
  const context = {
    roomId: command.roomId,
    authorityEpoch: room.epoch,
    revision: room.revision,
  };
  if (!room.snapshot)
    return new Response(null, {
      status: 404,
      headers: { [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify(context) },
    });
  return new Response(room.snapshot, {
    headers: {
      "content-type": "application/octet-stream",
      [SNAPSHOT_RECEIPT_HEADER]: JSON.stringify({
        ...context,
        byteLength: room.snapshot.byteLength,
        checksum: room.checksum,
      }),
    },
  });
};

class FixtureRoom extends CollaborationRoomV2 {
  async advanceFixtureV1() {
    await this.alarm();
  }
}
class FixtureLifecycle extends CollaborationLifecycle {
  async advanceFixtureV1() {
    await this.alarm();
  }
}
export {
  FixtureRoom as CollaborationRoomV2,
  FixtureLifecycle as CollaborationLifecycle,
};
export default {
  async fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
    env: Env,
  ): Promise<Response> {
    if (new URL(request.url).pathname === "/__fixture/advance") {
      const body = await request.json<{
        roomId?: string;
        lifecycle?: string;
      }>();
      const stub = body.roomId
        ? env.COLLABORATION_ROOM.getByName(body.roomId)
        : env.COLLABORATION_LIFECYCLE.getByName(body.lifecycle!);
      await (
        stub as unknown as { advanceFixtureV1(): Promise<void> }
      ).advanceFixtureV1();
      return Response.json({ advanced: true });
    }
    return worker.fetch(request, env);
  },
};
