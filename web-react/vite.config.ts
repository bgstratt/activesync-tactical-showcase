import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

function resolveBuildRef(): string {
  const fromEnv = process.env.VITE_BUILD_REF ?? process.env.VITE_GIT_COMMIT ?? process.env.VITE_COMMIT_SHA;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

const buildRef = resolveBuildRef();

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_BUILD_REF": JSON.stringify(buildRef)
  }
});
