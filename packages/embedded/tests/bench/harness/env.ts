import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));

export function readEnvValue(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  return readLocalEnvValue(name);
}

function readLocalEnvValue(name: string): string | undefined {
  try {
    const env = readFileSync(path.join(repoRoot, ".env.local"), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 0) continue;
      if (trimmed.slice(0, separator).trim() !== name) continue;
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/\s+#.*$/, "")
        .replace(/^['"]|['"]$/g, "");
      return value || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function readHostedRemoteUrl(): string | undefined {
  const explicit = readEnvValue("VITE_CONVEX_URL");
  if (!explicit) return undefined;
  try {
    const url = new URL(explicit);
    if (url.protocol !== "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return undefined;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function readNumberEnvValue(name: string, fallback: number): number {
  const raw = readEnvValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function readNumberListEnvValue(name: string, fallback: number[]): number[] {
  const raw = readEnvValue(name);
  if (raw === undefined) return fallback;
  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part) && part >= 0);
  return parsed.length > 0 ? parsed : fallback;
}

export function readTabsEnvValue(
  name: string,
  fallback: Array<"one" | "two">,
): Array<"one" | "two"> {
  const raw = readEnvValue(name);
  if (raw === undefined) return fallback;
  const parsed = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is "one" | "two" => part === "one" || part === "two");
  return parsed.length > 0 ? parsed : fallback;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
