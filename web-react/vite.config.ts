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

function setWasmMimeHeader(url: string | undefined, res: { setHeader: (name: string, value: string) => void }): void {
  if (!url) {
    return;
  }

  const path = url.split("?")[0] ?? "";
  if (!path.endsWith(".wasm")) {
    return;
  }

  res.setHeader("Content-Type", "application/wasm");
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "wasm-mime-type-fix",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          setWasmMimeHeader(req.url, res);
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          setWasmMimeHeader(req.url, res);
          next();
        });
      }
    }
  ],
  define: {
    "import.meta.env.VITE_BUILD_REF": JSON.stringify(buildRef)
  }
});
