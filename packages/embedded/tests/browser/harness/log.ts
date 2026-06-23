import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const browserLogPath = fileURLToPath(new URL("../.logs/runtime.log", import.meta.url));
let browserLogInitialized = false;

export function browserRuntimeLog() {
  return {
    name: "convex-embedded:browser-log",
    configureServer(server: {
      middlewares: {
        use(
          route: string,
          handler: (
            req: { originalUrl?: string; url?: string },
            res: { end(body?: string): void; setHeader(name: string, value: string): void },
          ) => void,
        ): void;
        use(
          handler: (
            req: { originalUrl?: string; url?: string },
            res: unknown,
            next: () => void,
          ) => void,
        ): void;
      };
    }) {
      appendBrowserLog({ phase: "server:start", source: "vite" });
      server.middlewares.use((req, _res, next) => {
        const url = req.originalUrl ?? req.url ?? "";
        if (shouldLogRequest(url)) {
          appendBrowserLog({ phase: "server:request", source: "vite", url });
        }
        next();
      });
      server.middlewares.use("/__convex_embedded_page", (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.end('<!doctype html><html><body><main id="root"></main></body></html>');
      });
      server.middlewares.use("/__convex_embedded_browser_log", (req, res) => {
        try {
          const rawUrl = req.originalUrl ?? req.url ?? "";
          const url = new URL(rawUrl, "http://localhost");
          const entry = url.searchParams.get("entry") ?? "{}";
          appendBrowserLog(JSON.parse(entry) as Record<string, unknown>);
          res.setHeader("Content-Type", "application/json");
          res.end('{"ok":true}');
        } catch (error) {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });
    },
  };
}

function appendBrowserLog(entry: Record<string, unknown>): void {
  initBrowserLog();
  appendFileSync(browserLogPath, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`, "utf8");
}

function initBrowserLog(): void {
  if (browserLogInitialized) return;
  browserLogInitialized = true;
  mkdirSync(path.dirname(browserLogPath), { recursive: true });
  rmSync(browserLogPath, { force: true });
}

function shouldLogRequest(url: string): boolean {
  return (
    url.includes("__vitest") ||
    url.includes("__vitest_browser") ||
    url.includes("tests/browser") ||
    url.includes("@id/") ||
    url.includes("@fs/")
  );
}
