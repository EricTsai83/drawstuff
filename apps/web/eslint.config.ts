import nextLintConfig from "eslint-config-next/core-web-vitals";
// @ts-ignore -- no types for this plugin
import drizzle from "eslint-plugin-drizzle";

const adapterDeepImportRestriction = {
  regex:
    "^@drawstuff/excalidraw-adapter/(?!client$|codec$|library$|reconcile$|types$)",
  message:
    "Import an explicit @drawstuff/excalidraw-adapter public entry point.",
};

const adapterInternalPathRestriction = {
  group: ["**/packages/excalidraw-adapter/**"],
  message: "Import @drawstuff/excalidraw-adapter through its package exports.",
};

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
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@excalidraw/excalidraw",
              message:
                "Use an explicit @drawstuff/excalidraw-adapter entry point.",
            },
          ],
          patterns: [
            {
              group: ["@excalidraw/excalidraw/*"],
              message:
                "Use an explicit @drawstuff/excalidraw-adapter entry point.",
            },
            adapterDeepImportRestriction,
            adapterInternalPathRestriction,
          ],
        },
      ],
      "drizzle/enforce-delete-with-where": [
        "error",
        { drizzleObjectName: ["db", "ctx.db"] },
      ],
      "drizzle/enforce-update-with-where": [
        "error",
        { drizzleObjectName: ["db", "ctx.db"] },
      ],
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
