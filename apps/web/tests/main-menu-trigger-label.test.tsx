import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useMainMenuTriggerAccessibleName } from "@/components/excalidraw/main-menu/accepted-limitation-trigger-label";

/**
 * Contract test for the one sanctioned DOM workaround (see the module's header
 * comment). It pins both halves of the escape hatch: the immediate repair, and
 * the MutationObserver that waits for upstream's tunneled trigger to mount.
 */

const actEnvironment = globalThis as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

/** Lets React's `act` flush the effect and the observer's microtask queue. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function TriggerLabelProbe({ langCode }: { langCode: string }) {
  useMainMenuTriggerAccessibleName(langCode);
  return null;
}

function mountUpstreamTrigger(): HTMLButtonElement {
  const trigger = document.createElement("button");
  trigger.setAttribute("data-testid", "main-menu-trigger");
  document.body.appendChild(trigger);
  return trigger;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("main menu trigger accessible name (accepted limitation)", () => {
  it("labels a trigger that upstream already mounted", () => {
    const trigger = mountUpstreamTrigger();

    act(() => root.render(<TriggerLabelProbe langCode="en" />));

    expect(trigger.getAttribute("aria-label")).toBe("Menu");
  });

  it("waits for the tunneled trigger and labels it once it appears", async () => {
    act(() => root.render(<TriggerLabelProbe langCode="en" />));

    const trigger = mountUpstreamTrigger();
    await flush();

    expect(trigger.getAttribute("aria-label")).toBe("Menu");
  });

  it("re-labels the trigger that a language switch remounts", async () => {
    mountUpstreamTrigger();
    act(() => root.render(<TriggerLabelProbe langCode="en" />));

    // Switching locale tears the tunneled trigger down and mounts a fresh one
    // without the repaired attribute.
    document.body.replaceChildren(container);
    act(() => root.render(<TriggerLabelProbe langCode="zh-TW" />));
    const remounted = mountUpstreamTrigger();
    await flush();

    expect(remounted.getAttribute("aria-label")).toBe("選單");
  });

  it("stops observing once the trigger is labelled", async () => {
    act(() => root.render(<TriggerLabelProbe langCode="en" />));

    const trigger = mountUpstreamTrigger();
    await flush();
    trigger.removeAttribute("aria-label");

    // A later unrelated mutation must not re-trigger the disconnected observer.
    document.body.appendChild(document.createElement("span"));
    await flush();

    expect(trigger.getAttribute("aria-label")).toBeNull();
  });
});
