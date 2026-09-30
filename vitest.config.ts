// Root test runner (npm run test:unit and the emulator suites). The web code imports shared/ as @shared, like its
// Vite config (web/vite.config.ts).
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@shared": path.resolve(__dirname, "shared") } },
});
