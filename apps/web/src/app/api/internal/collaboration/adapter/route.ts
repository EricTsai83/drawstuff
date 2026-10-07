import { env } from "@/env";
import { db } from "@/server/db";
import { handleAdapterRequest } from "@/server/collab/adapter-http";

export const runtime = "nodejs";
export const maxDuration = 60;

export function POST(request: Request) {
  return handleAdapterRequest(request, db, env.COLLAB_ADAPTER_SECRET);
}
