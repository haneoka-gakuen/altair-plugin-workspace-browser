import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    lib: {
      entry: {
        archive: resolve(root, "src/archive.ts"),
        assets: resolve(root, "src/assets.ts"),
        environment: resolve(root, "src/environment.ts"),
        index: resolve(root, "src/index.ts"),
        persistence: resolve(root, "src/persistence.ts"),
        plugin: resolve(root, "src/plugin.ts"),
        workspace: resolve(root, "src/workspace.ts"),
      },
      fileName: (_format, entry) => `${entry}.js`,
      formats: ["es"],
    },
    rollupOptions: {
      external: (id) => id === "fflate" || id === "@haneoka/altair" || id.startsWith("@haneoka/altair/"),
    },
    sourcemap: true,
    target: "es2022",
  },
});
