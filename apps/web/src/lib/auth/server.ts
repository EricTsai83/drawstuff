import "server-only";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

export async function getServerSession(): Promise<AuthSession> {
  return await auth.api.getSession({
    headers: await headers(),
  });
}
