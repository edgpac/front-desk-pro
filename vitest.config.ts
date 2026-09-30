import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts — that config's TanStack Start
// + Nitro + Tailwind plugins are for building/serving the app, not for
// running unit tests against plain, server-independent functions (the
// only kind of test this repo has today; see the "Critical missing tests"
// section of ROADMAP.md). Keeping this minimal (just the @/ alias every
// src file already uses) avoids pulling SSR/build tooling into a plain
// Node test run.
export default defineConfig({
  resolve: {
    alias: { "@": `${process.cwd()}/src` },
  },
  test: {
    environment: "node",
  },
});
