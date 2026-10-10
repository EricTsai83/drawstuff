// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTransientKey } from "@/hooks/use-transient-key";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const seen: { value?: boolean } = {};
function Probe(props: { keyValue: string | null; scope?: string | null }) {
  seen.value = useTransientKey(props.keyValue, 1000, props.scope ?? "room-a");
  return null;
}

let root: Root;
const render = (keyValue: string | null, scope?: string | null) =>
  act(() => root.render(<Probe keyValue={keyValue} scope={scope} />));

beforeEach(() => {
  vi.useFakeTimers();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

/** A save's check mark flashes once per confirmed save, then settles. */
describe("useTransientKey", () => {
  it("treats the state found on arrival as already shown", () => {
    render(null);
    render("saved:1");
    expect(seen.value).toBe(false);
    // A new room's first state is its arrival state too.
    render("saved:7", "room-b");
    expect(seen.value).toBe(false);
  });

  it("is true briefly after each new key and false otherwise", () => {
    render(null);
    expect(seen.value).toBe(false);
    render("saved:0");
    render("saved:1");
    expect(seen.value).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(seen.value).toBe(false);
    // The same state persisting does not flash again; a new save does.
    render("saved:1");
    expect(seen.value).toBe(false);
    render("saved:2");
    expect(seen.value).toBe(true);
  });
});
