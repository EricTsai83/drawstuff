import nextLintConfig from "eslint-config-next/core-web-vitals";

import baseConfig from "../../eslint.config.js";

const eslintConfig = [
  ...nextLintConfig,
  ...baseConfig,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/incompatible-library": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
