// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MultipleSelector, {
  type Option,
} from "@/components/ui/multiple-selector";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // cmdk scrolls the active item into view; jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function type(input: HTMLInputElement, value: string) {
  // React tracks the value property; set it through the prototype setter.
  Reflect.set(HTMLInputElement.prototype, "value", value, input);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const option = (label: string): Option => ({ value: label, label });

describe("MultipleSelector async search", () => {
  it("ignores an older response that resolves after a newer one", async () => {
    const pending = new Map<string, (options: Option[]) => void>();
    const onSearch = (term: string) =>
      new Promise<Option[]>((resolve) => pending.set(term, resolve));

    act(() => root.render(<MultipleSelector onSearch={onSearch} delay={0} />));
    const input = container.querySelector("input")!;

    await act(async () => {
      input.focus();
      type(input, "a");
      await new Promise((r) => setTimeout(r, 5));
    });
    await act(async () => {
      type(input, "ab");
      await new Promise((r) => setTimeout(r, 5));
    });

    await act(async () => {
      pending.get("ab")?.([option("ab-result")]);
      await Promise.resolve();
    });
    await act(async () => {
      pending.get("a")?.([option("a-stale")]);
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("ab-result");
    expect(document.body.textContent).not.toContain("a-stale");
  });
});
