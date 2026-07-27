import { whiteboardDiagnosticSchema } from "@drawstuff/whiteboard";
import { getServerSession } from "@/lib/auth/server";

export async function POST(request: Request): Promise<Response> {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ ok: false }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const parsed = whiteboardDiagnosticSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false }, { status: 400 });
  }

  // The strict schema intentionally excludes document/user IDs, scene
  // content, asset payloads, names, and free-form errors.
  console.info("whiteboard-diagnostic", parsed.data);
  return Response.json({ ok: true }, { status: 202 });
}
