// Flat config (ESLint 9). Deliberately pragmatic: this repo's only quality
// gate used to be `tsc --strict`, so the goal here is to catch the traps tsc
// does not — above all `console.log` on a stdio JSON-RPC server — without
// forcing a repo-wide rewrite of code that was written the way it is on purpose.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build output is generated, dependencies are not ours.
    ignores: ["dist/**", "node_modules/**"],
  },

  // ---------------------------------------------------------------- src/*.ts
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // The MCP server speaks JSON-RPC over stdout, so any stray console.log
      // corrupts the protocol stream and shows up as a broken client. All
      // diagnostics must go to stderr and opt out explicitly, per call site.
      "no-console": "error",

      // Disabled-as-warning, not off: Jira/Confluence Data Center responses are
      // large, version-dependent and only partially documented, so the client
      // layer parses them through deliberate `any` (72 sites today). Making it
      // an error would either block the build or invite a blanket file-level
      // disable; a warning keeps the count visible without gating CI.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // ------------------------------------------------------------ src/__tests__
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      // Tests fabricate malformed Atlassian payloads on purpose to prove the
      // parsers survive them; `any` is the point, not an oversight.
      "@typescript-eslint/no-explicit-any": "off",
      // Assertions often bind a value only to prove it was produced.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },

  // ------------------------------------------------------------ scripts/*.mjs
  {
    files: ["scripts/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      // Node globals actually used by these two scripts; declared by hand so
      // the config does not depend on the `globals` package.
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      // deploy.mjs and smoke-test.mjs are operator-facing CLIs run by hand:
      // their stdout output IS the deliverable, so no-console makes no sense.
      "no-console": "off",
    },
  },
);
