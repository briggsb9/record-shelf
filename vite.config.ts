import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "development") },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
