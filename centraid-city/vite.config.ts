import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  base: mode === "site" ? "/city/" : "/",
}));
