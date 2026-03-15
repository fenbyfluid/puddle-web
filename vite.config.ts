import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  server: {
    proxy: {
      // These two are used by the QuestDB page
      '/questdb/': {
        target: 'http://puddle.local/',
      },
      '/assets/vs/': {
        target: 'http://puddle.local/',
      },
    },
  },
});
