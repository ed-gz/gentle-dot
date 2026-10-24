import { defineConfig } from "vitest/config";

export default defineConfig({
 test: { include: ["packages/theme-capri/test/**/*.test.ts"], environment: "node" },
});
