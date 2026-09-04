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
    // node-server: deployable anywhere that runs Node (Vercel, Railway,
    // Render, a plain VPS) instead of assuming a specific edge platform.
    plugins.push(nitro({ preset: "node-server" }));
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
