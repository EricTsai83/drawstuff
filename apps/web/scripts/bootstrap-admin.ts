import { bootstrapFirstAdmin } from "@/server/admin/bootstrap";
import { db } from "@/server/db";

function readEmail(argv: readonly string[]): string {
  const flagIndex = argv.indexOf("--email");
  const email = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  if (!email || flagIndex !== argv.length - 2) {
    throw new Error("Usage: pnpm admin:bootstrap --email operator@example.com");
  }
  return email;
}

const result = await bootstrapFirstAdmin({
  db,
  email: readEmail(process.argv.slice(2)),
});

console.info(
  result.status === "granted"
    ? `Granted operator access to ${result.email} (${result.userId}).`
    : `${result.email} (${result.userId}) is already an active operator.`,
);
process.exit(0);
