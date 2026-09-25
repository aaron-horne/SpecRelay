import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./artifacts/gateway-console/src", import.meta.url)),
    },
  },
  test: {
    include: [
      "lib/*/src/**/*.test.ts",
      "artifacts/api-server/src/**/*.test.ts",
      "artifacts/gateway-console/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    sequence: { concurrent: false },
  },
});