// eslint-plugin-drizzle ships no types; declare the flat-config plugin shape
// so the ESLint config type-checks without a suppression.
declare module "eslint-plugin-drizzle" {
  import type { ESLint } from "eslint";

  const plugin: ESLint.Plugin;
  export default plugin;
}
