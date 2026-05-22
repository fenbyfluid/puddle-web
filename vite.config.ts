import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  server: {
    proxy: {
      // The Puddle websocket
      '/ws': {
        target: 'ws://puddle.local/',
        ws: true,
      },
      // This is used by the VNC page
      '/websockify': {
        target: 'ws://puddle.local/',
        ws: true,
      },
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
