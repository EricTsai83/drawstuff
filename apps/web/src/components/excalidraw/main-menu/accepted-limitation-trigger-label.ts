"use client";

import { useEffect } from "react";

/**
 * ACCEPTED LIMITATION — the single sanctioned DOM workaround in this repo.
 *
 * `MainMenu` (upstream 0.18.1) always renders its own tunneled trigger:
 * `MainMenu.tsx` hard-codes `<DropdownMenu.Trigger data-testid="main-menu-trigger">`
 * with only the hamburger icon as children, and forwards nothing from the host.
 * `MainMenu.Trigger` *is* exported, but `DropdownMenu` picks the trigger out of
 * its own children (`getMenuTriggerComponent`), never out of the host subtree,
 * so a host-rendered `MainMenu.Trigger` lands inside the dropdown content
 * instead of replacing the real trigger. The button therefore ships with no
 * accessible name and fails the axe smoke test.
 *
 * Verified against the lockfile-resolved `@excalidraw/excalidraw@0.18.1`:
 * - `dist/dev/index.js:17552-17565` (MainMenu renders the trigger itself)
 * - `dist/dev/index.js:10729-10761` (the trigger sets no aria-label/title)
 * - `dist/dev/index.js:10889-10901` (`getMenuTriggerComponent` child lookup)
 * There is no `trigger` / `renderTrigger` / `triggerProps` prop on `MainMenu`,
 * and no upstream issue is tracked for it at the time of writing.
 *
 * REMOVAL CONDITION: delete this module (and its ESLint exemption in
 * `eslint.config.ts`) as soon as upstream either gives its own trigger an
 * accessible name or accepts a host-supplied one. The `MainMenu` slot audit in
 * `packages/excalidraw-adapter/tests/upstream-capability-audit.test.ts` fails
 * the moment that surface changes, which is the signal to re-check.
 *
 * DO NOT COPY THIS PATTERN. Every other product feature must mount through an
 * upstream public prop or slot — see
 * `docs/architecture/native-ui-integration-contract.md`.
 */
const MAIN_MENU_TRIGGER_SELECTOR = '[data-testid="main-menu-trigger"]';

/** Labels the trigger if it is already mounted, reporting whether it was found. */
function labelMainMenuTrigger(label: string): boolean {
  const trigger = document.querySelector<HTMLButtonElement>(
    MAIN_MENU_TRIGGER_SELECTOR,
  );
  if (!trigger) return false;
  trigger.setAttribute("aria-label", label);
  return true;
}

/**
 * Labels the trigger now, or waits for the tunnel to mount it. Returns the
 * teardown for the pending observation.
 */
function repairMainMenuTriggerAccessibleName(label: string): () => void {
  if (labelMainMenuTrigger(label)) return () => undefined;

  const observer = new MutationObserver(() => {
    if (labelMainMenuTrigger(label)) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/**
 * Takes the already-translated label so this DOM workaround stays free of i18n
 * plumbing, plus the Excalidraw `langCode` that drives the remount.
 *
 * Both are dependencies on purpose: upstream remounts the tunneled trigger the
 * moment its own `langCode` changes, which is *before* the app dictionary for
 * the new locale finishes loading. Depending on the label alone would leave the
 * freshly mounted trigger without an accessible name for that window — and
 * permanently if the dictionary chunk never arrives.
 */
export function useMainMenuTriggerAccessibleName(
  label: string,
  langCode: string,
): void {
  useEffect(
    () => repairMainMenuTriggerAccessibleName(label),
    [label, langCode],
  );
}
