import type { InferSelectModel } from "drizzle-orm";
import type { user, session } from "@/server/db/schema";

// Client-safe auth shapes (match authClient.useSession().data)
type ClientUser = Omit<InferSelectModel<typeof user>, "image"> & {
  readonly image?: string | null;
};
type ClientSession = Omit<
  InferSelectModel<typeof session>,
  "ipAddress" | "userAgent"
> & {
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
};
export type AuthSessionData = {
  readonly user: ClientUser;
  readonly session: ClientSession;
} | null;
