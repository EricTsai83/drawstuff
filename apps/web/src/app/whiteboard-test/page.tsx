import { notFound } from "next/navigation";
import type { WhiteboardTestFixtureName } from "@/test-mode/whiteboard-fixtures";

const FIXTURES = new Set<WhiteboardTestFixtureName>([
  "mixed-1k",
  "mixed-10k",
  "mixed-50k",
  "visible-1k-of-10k",
  "text-500",
  "freedraw-2k",
]);

export default async function WhiteboardTestPage({
  searchParams,
}: {
  readonly searchParams: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}) {
  if (process.env.NEXT_PUBLIC_WHITEBOARD_TEST_MODE !== "1") notFound();
  const { WhiteboardTestHarness } =
    await import("@/test-mode/whiteboard-test-harness");
  const params = await searchParams;
  const requestedFixture =
    typeof params.fixture === "string" ? params.fixture : "mixed-1k";
  const fixture = FIXTURES.has(requestedFixture as WhiteboardTestFixtureName)
    ? (requestedFixture as WhiteboardTestFixtureName)
    : "mixed-1k";
  const theme = params.theme === "dark" ? "dark" : "light";
  return <WhiteboardTestHarness fixture={fixture} theme={theme} />;
}
