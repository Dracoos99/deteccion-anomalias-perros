// Lint of the TypeScript and JavaScript code: the recommended rules of typescript-eslint, and the rules of
// hooks for the web app. Style is not linted. Run with: npm run lint
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const NODE_GLOBALS = { process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly", fetch: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", performance: "readonly", __dirname: "readonly", require: "readonly", module: "readonly" };
const BROWSER_GLOBALS = { window: "readonly", document: "readonly", localStorage: "readonly", location: "readonly", history: "readonly", getComputedStyle: "readonly", dispatchEvent: "readonly", PopStateEvent: "readonly" };

export default tseslint.config(
  // The folders to lint are named in the lint script (package.json), so the documentation and tool folders are never read.
  { ignores: ["**/node_modules/**", "**/dist/**", "**/lib/**", "functions/src/shared/**", "web/public/**", "tests/e2e/shots/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Names that start with an underscore are unused on purpose (a destructured field left out).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // A comment inside an empty block says why it is empty (localStorage may be blocked).
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" },
  },
  // Scripts and e2e tests run in Node; the e2e ones also evaluate code inside the page.
  { files: ["scripts/**/*.{mjs,cjs}", "functions/scripts/**/*.cjs", "tests/e2e/**/*.mjs", "*.mjs"], languageOptions: { globals: { ...NODE_GLOBALS, ...BROWSER_GLOBALS } } },
  { files: ["**/*.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } },
  // A test may build a loose fixture.
  { files: ["**/test/**/*.ts", "tests/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
