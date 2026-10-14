import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import preact from "@astrojs/preact";

export default defineConfig({
  integrations: [preact()],
  output: "server",
  adapter: node({ mode: "standalone" }),
  build: {
    inlineStylesheets: "auto",
  },
  server: {
    host: true,
    port: 4742,
  },
});
