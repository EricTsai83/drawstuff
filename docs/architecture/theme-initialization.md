# Theme initialization

Use the original `next-themes@0.4.6` package without a patch or local fork.
`ThemeProvider` stays in the root layout, above route content. Do not key it by
pathname or theme, or conditionally mount it after hydration: normal navigation
must preserve the existing provider and its server-rendered initialization script.

The configuration remains `attribute="class"`, `defaultTheme="system"`,
`enableSystem`, and `storageKey="theme"`. Existing preferences need no migration.
The original bootstrap applies the saved/system theme before hydration; provider
effects handle later theme changes and storage/system events.

The public viewer is responsible for keeping its server output and first
hydration render consistent. Its hydration snapshot initially uses the same
icon/label fallback on both sides, then exposes the resolved browser theme. SVG
loading waits for both hydration and a valid resolved theme, avoiding an early
request for the wrong artifact. The loading overlay leaves the viewport backdrop
visible while scene fonts load.

`<html suppressHydrationWarning>` covers the expected root theme attributes. It
does not cover nested icon structure changes or React's client-created script
warning. Fix mismatches in the component that renders inconsistent output.

A package patch was removed after verifying the original package in the actual
browser-delivered JavaScript. Saved light/dark initial loads, full reloads, and
public-page -> homepage -> back navigation produced no hydration or script-tag
warnings. The existing viewer fixes were sufficient for these normal flows.

This does not change next-themes behavior on a genuinely client-only mount, such
as a root rebuilt after another hydration failure. If a warning returns, inspect
the first hydration error and provider remounts before changing dependencies.

Regression coverage:

- `apps/web/tests/theme-provider-script.test.tsx`: original server bootstrap,
  hydration, persistence, system changes, cross-tab synchronization, blocked
  storage, and the public viewer with the real provider.
- `apps/web/tests/published-viewer-theme.test.tsx`: differing server/client themes
  and avoiding premature or incorrect SVG requests.

Tests use hydration for the real root provider, matching the application's SSR
architecture. Browser checks are still needed for actual first-paint behavior;
jsdom cannot prove the absence of a visible flash. Unrelated font/CSP warnings
were observed during browser checks and remain separate issues.
