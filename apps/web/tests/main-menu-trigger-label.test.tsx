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

function TriggerLabelProbe({
  label,
  langCode = "en",
}: {
  label: string;
  langCode?: string;
}) {
  useMainMenuTriggerAccessibleName(label, langCode);
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

    act(() => root.render(<TriggerLabelProbe label="Menu" />));

    expect(trigger.getAttribute("aria-label")).toBe("Menu");
  });

  it("waits for the tunneled trigger and labels it once it appears", async () => {
    act(() => root.render(<TriggerLabelProbe label="Menu" />));

    const trigger = mountUpstreamTrigger();
    await flush();

    expect(trigger.getAttribute("aria-label")).toBe("Menu");
  });

  it("re-labels the trigger that a language switch remounts", async () => {
    mountUpstreamTrigger();
    act(() => root.render(<TriggerLabelProbe label="Menu" langCode="en" />));

    // Switching locale changes the label and tears the tunneled trigger down,
    // mounting a fresh one without the repaired attribute.
    document.body.replaceChildren(container);
    act(() => root.render(<TriggerLabelProbe label="選單" langCode="zh-TW" />));
    const remounted = mountUpstreamTrigger();
    await flush();

    expect(remounted.getAttribute("aria-label")).toBe("選單");
  });

  it("re-labels the remounted trigger before the new dictionary arrives", async () => {
    mountUpstreamTrigger();
    act(() => root.render(<TriggerLabelProbe label="Menu" langCode="en" />));

    // Upstream remounts the trigger as soon as its own langCode changes, which
    // happens before the app dictionary for the new locale resolves: the label
    // is still the old one, so only langCode signals that a repair is needed.
    document.body.replaceChildren(container);
    act(() => root.render(<TriggerLabelProbe label="Menu" langCode="zh-TW" />));
    const remounted = mountUpstreamTrigger();
    await flush();

    expect(remounted.getAttribute("aria-label")).toBe("Menu");
  });

  it("stops observing once the trigger is labelled", async () => {
    act(() => root.render(<TriggerLabelProbe label="Menu" />));

    const trigger = mountUpstreamTrigger();
    await flush();
    trigger.removeAttribute("aria-label");

    // A later unrelated mutation must not re-trigger the disconnected observer.
    document.body.appendChild(document.createElement("span"));
    await flush();

    expect(trigger.getAttribute("aria-label")).toBeNull();
  });
});
