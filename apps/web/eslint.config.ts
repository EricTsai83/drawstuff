import nextLintConfig from "eslint-config-next/core-web-vitals";
// @ts-ignore -- no types for this plugin
import drizzle from "eslint-plugin-drizzle";

import { sharedTypescriptRules } from "../../eslint.shared.ts";

const upstreamDomLookupMessage =
  "Document-wide DOM lookups can reach into Excalidraw internals. Mount product UI through an upstream public prop or slot; the only accepted exception is apps/web/src/components/excalidraw/main-menu/accepted-limitation-trigger-label.ts.";

const documentLookupMethods =
  "/^(querySelector|querySelectorAll|getElementsByClassName|getElementsByTagName)$/";

/**
 * Product features mount into the editor through upstream public props and
 * slots only. A document-wide DOM lookup is how that rule gets bypassed, so it
 * is banned outright in app source; the single sanctioned exception is
 * exempted below. Element-scoped lookups (`ref.current.querySelector(...)`)
 * stay allowed — only roots that reach the whole document are matched.
 * See docs/architecture/native-ui-integration-contract.md.
 */
const upstreamDomLookupRestrictions = [
  // document.querySelector(...)
  `CallExpression[callee.object.name='document'][callee.property.name=${documentLookupMethods}]`,
  // document.body / document.documentElement / document.head .querySelector(...)
  `CallExpression[callee.object.object.name='document'][callee.property.name=${documentLookupMethods}]`,
  // window.document / globalThis.document .querySelector(...)
  `CallExpression[callee.object.property.name='document'][callee.property.name=${documentLookupMethods}]`,
  // window.document.body / globalThis.document.documentElement .querySelector(...)
  `CallExpression[callee.object.object.property.name='document'][callee.property.name=${documentLookupMethods}]`,
  // getElementById only exists on `document`, so ban it in any spelling.
  "CallExpression[callee.property.name='getElementById']",
].map((selector) => ({ selector, message: upstreamDomLookupMessage }));

const acceptedLimitationDomModule =
  "src/components/excalidraw/main-menu/accepted-limitation-trigger-label.ts";

const eslintConfig = [
  ...nextLintConfig,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      drizzle,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/incompatible-library": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      ...sharedTypescriptRules({
        canvasEngineMessage:
          "Use an explicit @drawstuff/excalidraw-adapter entry point.",
      }),
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...upstreamDomLookupRestrictions],
    },
  },
  {
    files: [acceptedLimitationDomModule],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
  },
];

export default eslintConfig;
