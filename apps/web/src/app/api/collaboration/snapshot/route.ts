import { handleSnapshotHttp } from "@/server/collab/snapshot-http";

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = handleSnapshotHttp;
