import tseslint from "typescript-eslint";
// @ts-ignore -- no types for this plugin
import drizzle from "eslint-plugin-drizzle";

import {
  adapterDeepImportRestriction,
  sharedTypescriptRules,
} from "./eslint.shared.ts";

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
    rules: sharedTypescriptRules({
      canvasEngineMessage:
        "Only @drawstuff/excalidraw-adapter may depend on the canvas engine.",
    }),
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
