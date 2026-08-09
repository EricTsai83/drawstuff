import tseslint from "typescript-eslint";
// @ts-ignore -- no types for this plugin
import drizzle from "eslint-plugin-drizzle";

const adapterDeepImportRestriction = {
  regex: "^@drawstuff/excalidraw-adapter/(?!client$|codec$|library$|types$)",
  message:
    "Import an explicit @drawstuff/excalidraw-adapter public entry point.",
};

const adapterInternalPathRestriction = {
  group: ["**/packages/excalidraw-adapter/**"],
  message: "Import @drawstuff/excalidraw-adapter through its package exports.",
};

export default tseslint.config(
  {
    ignores: [".deepsec/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      drizzle,
    },
    extends: [
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
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
                "Only @drawstuff/excalidraw-adapter may depend on the canvas engine.",
            },
          ],
          patterns: [
            {
              group: ["@excalidraw/excalidraw/*"],
              message:
                "Only @drawstuff/excalidraw-adapter may depend on the canvas engine.",
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
    files: [
      "packages/excalidraw-adapter/src/**/*.{ts,tsx}",
      "packages/excalidraw-adapter/tests/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@drawstuff/collaboration",
              message:
                "The adapter cannot depend on downstream collaboration code.",
            },
            {
              name: "@drawstuff/web",
              message: "The adapter cannot depend on downstream app code.",
            },
          ],
          patterns: [
            {
              group: [
                "@drawstuff/collaboration/*",
                "@drawstuff/web/*",
                "**/apps/web/**",
              ],
              message:
                "The adapter cannot import from a downstream workspace package.",
            },
            adapterDeepImportRestriction,
          ],
        },
      ],
    },
  },
  {
    files: ["apps/collaboration-relay/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@drawstuff/excalidraw-adapter",
              message:
                "The relay routes protocol frames; it cannot depend on the canvas engine boundary.",
            },
            {
              name: "react",
              message: "The relay is a headless service; no React.",
            },
          ],
          patterns: [
            {
              group: [
                "@drawstuff/excalidraw-adapter/*",
                "@drawstuff/web/*",
                "@excalidraw/*",
                "**/apps/web/**",
                "**/packages/excalidraw-adapter/**",
              ],
              message:
                "The relay may only import @drawstuff/collaboration protocol entries, ws, and node builtins.",
            },
          ],
        },
      ],
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
);
