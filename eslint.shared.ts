import type { Linter } from "eslint";

/**
 * Rule fragments shared by the root ESLint config (packages and the relay)
 * and `apps/web/eslint.config.ts` (which extends Next's config instead of
 * typescript-eslint's, and so cannot simply reuse the root config).
 *
 * The adapter entry whitelist below is the single copy: the two configs used
 * to carry their own regexes and had already drifted (the root one was
 * missing `reconcile$`).
 */

/** The adapter's public entry points; must match its package.json exports. */
export const ADAPTER_PUBLIC_ENTRIES = [
  "client",
  "codec",
  "reconcile",
  "testing",
  "types",
] as const;

export const adapterDeepImportRestriction = {
  regex: `^@drawstuff/excalidraw-adapter/(?!${ADAPTER_PUBLIC_ENTRIES.map(
    (entry) => `${entry}$`,
  ).join("|")})`,
  message:
    "Import an explicit @drawstuff/excalidraw-adapter public entry point.",
};

export const adapterInternalPathRestriction = {
  group: ["**/packages/excalidraw-adapter/**"],
  message: "Import @drawstuff/excalidraw-adapter through its package exports.",
};

/**
 * The rule block every TypeScript file in the repo gets, parameterized only
 * by how a config phrases the "don't import the canvas engine directly"
 * message for its audience.
 */
export function sharedTypescriptRules(options: {
  canvasEngineMessage: string;
}): Linter.RulesRecord {
  return {
    "@typescript-eslint/array-type": "off",
    "@typescript-eslint/consistent-type-definitions": "off",
    "@typescript-eslint/consistent-type-imports": [
      "warn",
      { prefer: "type-imports", fixStyle: "inline-type-imports" },
    ],
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
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
            message: options.canvasEngineMessage,
          },
        ],
        patterns: [
          {
            group: ["@excalidraw/excalidraw/*"],
            message: options.canvasEngineMessage,
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
  };
}
