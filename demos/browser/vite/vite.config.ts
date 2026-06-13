import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { convexEmbedded } from "@convex-dev/embedded/vite";

const convexDir = fileURLToPath(new URL("../../../convex", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "~convex": convexDir,
    },
  },
  plugins: [tailwindcss(), convexEmbedded({ convexDir })],
});
