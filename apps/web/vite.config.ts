import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Phase 6A §7: dev-only proxy to the Express server (src/http/server.ts) so
// the browser never needs CORS and no secret ever needs a VITE_* prefix.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:4300",
        changeOrigin: true,
      },
    },
  },
});
