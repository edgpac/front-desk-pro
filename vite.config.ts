import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

// Standalone Vite config (no external build-tool dependency). Mirrors the
// plugin order that matters for TanStack Start: tailwind + path aliases
// first, tanstackStart before the React plugin, nitro only on `build`.
export default defineConfig(async ({ command }) => {
  const plugins = [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({ server: { entry: "server" } }),
    viteReact(),
  ];

  if (command === "build") {
    const { nitro } = await import("nitro/vite");
    // Deployed on Vercel — this preset packages SSR routes and
    // createServerFn calls as Vercel serverless functions automatically.
    plugins.push(nitro({ preset: "vercel" }));
  }

  return {
    plugins,
    resolve: {
      alias: { "@": `${process.cwd()}/src` },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    server: { port: 8080 },
  };
});
