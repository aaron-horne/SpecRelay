import { defineConfig } from "vitest/config";

export default defineConfig({
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