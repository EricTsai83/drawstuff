import nextLintConfig from "eslint-config-next/core-web-vitals";
// @ts-ignore -- no types for this plugin
import drizzle from "eslint-plugin-drizzle";

const adapterDeepImportRestriction = {
  regex: "^@drawstuff/excalidraw-adapter/(?!client$|codec$|types$)",
  message:
    "Import an explicit @drawstuff/excalidraw-adapter public entry point.",
};

const adapterInternalPathRestriction = {
  group: ["**/packages/excalidraw-adapter/**"],
  message: "Import @drawstuff/excalidraw-adapter through its package exports.",
};

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
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
  },
];

export default eslintConfig;
