import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scraper/tests/**/*.test.ts"],
    environment: "node",
  },
});
