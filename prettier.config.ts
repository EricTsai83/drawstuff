import type { Config } from "prettier";
import type { PluginOptions } from "prettier-plugin-tailwindcss";

const prettierConfig = {
  plugins: ["prettier-plugin-tailwindcss"],
} satisfies Config & PluginOptions;

export default prettierConfig;
