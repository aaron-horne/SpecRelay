import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "lib/*/src/**/*.security.test.ts",
      "artifacts/api-server/src/**/*.security.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    sequence: { concurrent: false },
  },
});