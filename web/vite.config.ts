import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// vercel.json is the single source of truth for the security headers. `vite preview` serves the same
// ones, so the CSP is exercised by every local test, not only after deploying.
const vercel = JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url), "utf8"));
const headers = Object.fromEntries(vercel.headers[0].headers.map((h: { key: string; value: string }) => [h.key, h.value]));

export default defineConfig({
  plugins: [react()],
  preview: { headers },
});
