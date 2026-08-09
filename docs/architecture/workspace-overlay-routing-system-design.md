# Workspace overlay routing system design

- Status: Proposed
- Implementation plan: [Workspace 管理 Overlay Routing](../../plans/workspace-overlay-routing.md)
- Framework contract: [Next.js Parallel Routes](https://nextjs.org/docs/app/api-reference/file-conventions/parallel-routes),
  [Intercepting Routes](https://nextjs.org/docs/app/api-reference/file-conventions/intercepting-routes), and
  [`default.js`](https://nextjs.org/docs/app/api-reference/file-conventions/default)

This document defines the target navigation and UI contract for route-level workspace management
surfaces. It explains what the user sees during soft navigation, hard navigation, Back/Forward and
slot clearing, and it separates those responsibilities from local dialogs and Canvas persistence.

The design is proposed until the linked implementation plan is complete. After implementation and
verification, this document becomes the current routing contract and the plan is removed according
to `plans/README.md`.

## Problem statement

The Canvas is expensive and stateful. Recreating it can lose or disturb viewport, selection, undo
history, dirty state, collaboration ownership and the relationship between the in-memory scene and
its persisted scene session. Workspace management therefore must not replace the Canvas component
during ordinary in-app navigation.

The existing Dashboard already uses an intercepted parallel route, but the route content owns its
overlay wrapper and opens Workspace Create／Rename／Delete as additional local dialogs. That mixes
four concerns:

1. preserving the Canvas;
2. identifying a URL destination;
3. presenting that destination as an overlay;
4. handling a short-lived form or confirmation.

The target architecture separates them so each concern has one owner.

## Design goals

- Preserve the same Canvas React instance across workspace-management soft navigation.
- Give Dashboard, Create Workspace and Workspace Settings stable canonical URLs.
- Present those URLs over the Canvas when reached from the running application.
- Render usable canonical pages on direct entry or refresh.
- Make Back and Forward represent a predictable linear interaction history.
- Allow at most one route-level workspace overlay at a time.
- Prevent a stale parallel-route page from remaining visible after navigation leaves its scope.
- Keep search/filter state in the URL and short-lived input/confirmation state in components.
- Centralize focus, Escape, backdrop, scroll-lock and accessibility behavior.

## Non-goals

- Replacing the existing Scene Dashboard visual design.
- Renaming `/dashboard` or its product label in this change.
- Moving every popover, menu or confirmation into the router.
- Merging the separate authentication slot into the workspace overlay slot.
- Preserving an in-memory Canvas across a browser refresh, tab close or hard document navigation.

## Three-layer model

```text
Root/shared layouts
├── Canvas layer                     persistent application state
├── @overlay parallel slot           zero or one route-level management surface
└── local UI owned by active surface forms, popovers and confirmations
```

### Canvas layer

`(workspace)/layout.tsx` owns `ExcalidrawClientSideWrapper`. A client-side route transition below
the shared layout may replace a page or a parallel-slot subpage, but it must not key, template or
otherwise remount the Canvas. `SceneSessionProvider` remains above the route changes.

### Route-level overlay layer

One `@overlay` parallel slot presents destination-level UI. It is named after its presentation
role, not after one feature. The slot may contain Dashboard, Create Workspace or Workspace Settings,
but never more than one of them at the same time.

### Local UI layer

The active destination may own short-lived UI that does not need a durable URL, such as a Scene edit
dialog, a tooltip or typed deletion confirmation. Local UI must not become a second route-level
navigation system. The topmost local modal owns Escape and focus until it closes.

## Route model

| URL | Destination meaning | Query/local state policy |
| --- | --- | --- |
| `/` | Canvas | Canvas/session state only |
| `/dashboard` | Scene Dashboard | Optional filters in query |
| `/dashboard?workspaceId=<id>` | Scene browser scoped to one workspace | `workspaceId` is browser context, not a Canvas switch |
| `/workspaces/new` | Create Workspace workflow | Form draft is local state |
| `/workspaces/<id>/settings` | Settings for one workspace | Form and deletion confirmation are local state |

Dashboard search, archive and category filters may use query parameters because they describe a
repeatable view. `panel=settings`, `dialog=rename`, `dialog=delete` and typed confirmation text are
not URL state.

Every overlay destination has two presentations backed by the same content component:

```text
canonical page     direct entry / refresh → full management page
intercepted page   in-app soft navigation → modal surface over preserved Canvas
```

Content components do not know which presentation owns them. The canonical wrapper supplies
explicit navigation links; the intercepted wrapper supplies backdrop, focus and history close.

## Target route tree

```text
src/app/
├── layout.tsx
├── (workspace)/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── dashboard/page.tsx
│   └── workspaces/
│       ├── new/page.tsx
│       └── [workspaceId]/settings/page.tsx
├── @overlay/
│   ├── default.tsx
│   ├── page.tsx
│   ├── [...catchAll]/page.tsx
│   ├── (.)dashboard/page.tsx
│   └── (.)workspaces/
│       ├── new/page.tsx
│       └── [workspaceId]/settings/page.tsx
└── @auth/
    └── ...
```

The root layout conceptually composes the base route and named slots as siblings:

```tsx
<SceneSessionProvider>
  {children}
  {overlay}
  {auth}
</SceneSessionProvider>
```

Returning `null` from `@overlay` affects only the `overlay` placeholder. It does not return `null`
from the root layout and does not remove `children`.

## What an empty overlay means in UX

The rendered application always has a base layer. While the user works on `/`, that base layer is
the Canvas. `@overlay` is an optional sibling placed above it.

```text
overlay = DashboardContent  → Canvas visible underneath, dimmed and inert
overlay = SettingsContent   → Canvas visible underneath, dimmed and inert
overlay = null              → no backdrop or management surface; Canvas is fully visible and active
```

Therefore, `return null` does **not** create a blank screen. It means:

- route-level overlay DOM is absent;
- no overlay backdrop is painted;
- body/Canvas scroll and pointer interaction are restored;
- focus returns to an appropriate Canvas control or the recorded opener;
- screen readers no longer treat the background as inert;
- the base `children` route remains responsible for what the user sees.

On a canonical hard-loaded page, `children` may be the full Dashboard or Settings page instead of
the Canvas page. In that case `overlay = null` prevents a duplicate overlay; the user sees the
canonical page supplied by `children`.

## Why three null-producing files are required

`default.tsx`, `page.tsx` and `[...catchAll]/page.tsx` all return the same React value, but they are
selected in different navigation situations. Their sameness is intentional; their routing jobs are
not interchangeable.

### `@overlay/default.tsx`: hard-navigation fallback

```tsx
export default function Default() {
  return null;
}
```

During soft navigation Next.js remembers the active subpage for each parallel slot. On a hard
navigation—initial load, pasted URL or refresh—that client history is not available. If the current
URL cannot reconstruct a named slot's active subpage, Next.js uses the slot's `default.tsx`.

Its UX meaning is: “there is no route-level overlay state to restore.” The canonical `children`
page remains visible. Without a default for a named slot, an unmatched hard navigation can produce
a 404 instead of the intended base page.

Because the target slot also has explicit root and catch-all null routes, `default.tsx` is a safety
fallback rather than the usual close path. It remains part of the parallel-route contract.

### `@overlay/page.tsx`: explicitly clear the slot at `/`

```tsx
export default function OverlayRoot() {
  return null;
}
```

A non-optional `[...catchAll]` matches one or more URL segments; it does not match the empty root
path. An explicit slot page is therefore needed when a Link or router navigation moves from an
active overlay destination back to `/`.

Its UX meaning is: “the current destination is the Canvas itself; remove every route-level overlay
and make the Canvas interactive.” Browser Back can restore the same result from history, but an
explicit Link to `/` must also have a matching empty slot page.

### `@overlay/[...catchAll]/page.tsx`: clear stale slot state elsewhere

```tsx
export default function CatchAll() {
  return null;
}
```

Parallel slots are intentionally sticky during soft navigation: if a navigation does not match a
new subpage for a slot, Next.js may preserve the slot's previous active subpage. That is useful for
independent dashboard columns, but dangerous for a modal slot because an old Dashboard could remain
over a new destination.

The catch-all matches non-root URLs that are not handled by a more specific intercepted route and
actively changes the slot to `null`.

Its UX meaning is: “this destination does not own a workspace overlay; remove the previous one.”
The user sees the newly selected base page without a stale Dashboard or Settings surface covering
it.

Specific intercepted routes must win over the catch-all:

```text
soft /dashboard                       → (.)dashboard
soft /workspaces/new                  → (.)workspaces/new
soft /workspaces/<id>/settings        → specific settings intercept
soft /p/<slug> or another destination → [...catchAll] → null
```

Route tests must protect this precedence.

### Summary matrix

| File | Trigger | User-visible result |
| --- | --- | --- |
| `default.tsx` | Hard load cannot reconstruct the slot | Canonical/base page only; no overlay |
| `page.tsx` | Soft navigation explicitly reaches `/` | Original Canvas becomes active |
| `[...catchAll]/page.tsx` | Soft navigation reaches another non-overlay URL | New base page appears without stale overlay |

## Navigation and UX sequences

### Open Dashboard from Canvas

```text
1. User selects Dashboard from the Canvas menu.
2. Link performs a soft navigation to /dashboard.
3. children retains the mounted Canvas page.
4. @overlay/(.)dashboard renders RouteOverlay + DashboardContent.
5. URL changes to /dashboard.
6. Canvas remains visible but dimmed, inert and excluded from tab order.
7. Focus moves to the Dashboard heading or first meaningful control.
```

The user perceives an in-place management surface, not a page reload. Canvas state continues to
exist underneath.

### Move from Dashboard to Workspace Settings

```text
1. User selects Workspace settings.
2. Soft navigation moves to /workspaces/<id>/settings.
3. The same @overlay slot replaces Dashboard with Settings.
4. No second backdrop or route-level modal is stacked.
5. Canvas remains the unchanged base layer.
6. Browser history records Dashboard before Settings.
```

Back returns Settings → Dashboard; Back again returns Dashboard → Canvas. Settings replaces the
route-level surface rather than opening a Dialog over Dashboard.

### Create Workspace

Create follows the same route replacement model. Cancel uses Back in the intercepted presentation.
After successful creation, `router.replace('/dashboard?workspaceId=<new-id>')` removes the completed
form from Back history and selects the new workspace in Dashboard.

### Close the active overlay

Close button, Escape and backdrop all request the same history transition. The routed surface may
play its exit animation, then calls `router.back()`. Once the router commits the previous entry,
`@overlay/page.tsx`, a restored slot state or another specific intercepted route determines the next
surface.

When closing to Canvas, the observable result is:

```text
overlay surface exits
→ backdrop disappears
→ Canvas interaction is restored
→ focus returns to the opener or a stable Canvas control
→ scene/viewport/undo/session are unchanged
```

Browser Back must produce the same final state even when the close button was not used.

### Forward navigation

After Back closes an overlay, Forward re-enters its URL. Next.js restores the intercepted slot
state, and the corresponding route-level surface reopens over the still-mounted Canvas. Unsaved
form drafts are not guaranteed to survive because they are local state; persisted mutations and URL
filters are reconstructed.

### Refresh while an overlay URL is active

Refresh is a hard navigation. The browser cannot preserve the previous in-memory Canvas and the
interception context is not reconstructed. The canonical page renders in `children`, while
`@overlay` resolves to `null` through its matching clear route or fallback.

The user sees one complete Dashboard/Create/Settings page—not the canonical page plus a duplicate
modal. This is the expected difference between soft and hard navigation.

### Navigate to an unrelated destination

If a Link moves from Dashboard to a public scene or another non-overlay destination, the catch-all
renders `null`. The previous Dashboard does not remain sticky. If the destination leaves the shared
Canvas layout, preserving Canvas is not part of this subsystem's contract.

## History policy

| Action | Router operation | Reason |
| --- | --- | --- |
| Open Dashboard/Settings/Create | `push` via Link/router | Back should return to previous context |
| Cancel intercepted form | `back` | Restore the exact opener and its query filters |
| Successful Create | `replace` to selected Dashboard | Completed form must not reappear on Back |
| Successful Delete | `replace` to fallback Dashboard | Deleted Settings URL must not reappear |
| Canonical-page exit | explicit Link | Direct entry may not have safe same-app history |

Route content must not call `router.back()` directly. Only the intercepted presentation owns
history-close semantics.

## Focus, modality and accessibility

- A route-level overlay has one accessible Title even if the visual heading is custom.
- Opening it moves focus inside and makes the Canvas inert.
- Closing it restores focus; if the opener no longer exists, focus moves to a stable Canvas control.
- Escape closes only the topmost local modal or route overlay, never both.
- Backdrop click follows the same guarded close path as the close button.
- Body scroll is locked while the route overlay is active and restored when the slot becomes null.
- Dashboard's long content owns internal scrolling without moving the Canvas.
- Toasts remain global but do not capture focus.
- Route transitions announce the destination title and do not rely only on visual animation.

The application must not repair layering with component-specific z-index values. The shared
RouteOverlay and existing Base UI/shadcn primitives own layering and modality.

## Workspace and Canvas state boundaries

`workspaceId` in the Dashboard query is a scene-browser filter. It does not mutate the current
Canvas workspace or load a different scene. This prevents simply browsing another workspace from
changing the user's active work.

The settings target comes from the route parameter. Canvas main-menu Settings links to the current
Canvas workspace; Dashboard Settings links to the Dashboard-selected workspace. Those contexts are
deliberately distinct.

Deleting a workspace that owns the current Canvas scene crosses the routing boundary and must also
execute scene-session lifecycle cleanup. The operation clears current scene identity, revision,
dirty/workspace storage and safely resets the Canvas; collaboration must be left before deletion.
Redirecting alone is insufficient because a stale in-memory scene could otherwise be saved again.

## Error and invalid-state UX

- Unauthenticated access uses the existing authentication flow without exposing workspace data.
- Invalid UUID, missing workspace and unowned workspace share the same not-found result.
- A workspace deleted in another tab produces one toast and replaces the route with fallback
  Dashboard; it does not leave an empty Settings shell.
- A failed mutation keeps the form and entered values visible and reports the error near the action
  or through the existing toast contract.
- A route loading boundary shows a skeleton inside the management surface while Canvas remains
  stable underneath during intercepted navigation.
- If the overlay route fails, its error boundary must allow a safe return to Canvas or Dashboard.

## Security and privacy

Workspace route params are untrusted input. Every read and mutation revalidates authentication and
ownership server-side; client selection and disabled buttons are not authorization controls.
Missing and unowned resources are intentionally indistinguishable. URLs contain opaque workspace
IDs and filter values only—never scene data, confirmation text or authentication secrets.

## Verification contract

Automated coverage must prove:

- specific intercepted routes beat the catch-all;
- `@overlay/page.tsx` clears the slot at `/`;
- catch-all clears a previously active slot on other soft navigations;
- hard-loaded canonical pages render once with no duplicate overlay;
- Back/Forward follows Canvas → Dashboard → Settings/Create in both directions;
- Canvas DOM identity, scene content, undo history, dirty state and session survive soft navigation;
- inner Scene/category dialogs own Escape before RouteOverlay;
- focus, inert state and scroll lock change with overlay presence;
- Create/Delete success uses replace semantics;
- deleting the current Canvas workspace clears session and cannot produce a ghost save.

Manual verification must include browser refresh, pasted URLs, mouse/backdrop close, keyboard-only
navigation, browser Back/Forward and responsive layouts.

## Architectural invariants

1. Canvas persistence is owned by the shared layout, not by an individual page or query parameter.
2. A canonical URL describes a destination; interception only changes its presentation during soft
   navigation.
3. `@overlay` contains zero or one route-level workspace surface.
4. Returning `null` empties only the named slot; it never means the application has no base UI.
5. `default.tsx` handles unknown hard-navigation slot state; explicit root/catch-all pages clear
   known soft-navigation slot state.
6. Local dialogs do not encode navigation and cannot close a parent route overlay accidentally.
7. Direct entry is usable without relying on browser history.
8. Workspace deletion coordinates route, server data and Canvas session lifecycle as one user-visible
   operation.
