import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const rootEnvFile = new URL("../.env.local", import.meta.url);
export const repoRoot = fileURLToPath(new URL("../", import.meta.url));

type EnvValues = Readonly<Record<string, string | undefined>>;

/** Parse one `.env.local`, treating an absent file as an empty environment. */
export function parseEnvFile(file: URL): EnvValues {
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

/** Read a value from the process environment, then the named `.env.local` files in order. */
export function readValue(name: string, files: readonly URL[] = [rootEnvFile]): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  for (const file of files) {
    const value = parseEnvFile(file)[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function readNumber(name: string, fallback: number): number {
  const raw = readValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function readFlag(name: string): boolean {
  return readValue(name) === "1";
}

export function readList(name: string, fallback: readonly number[]): number[] {
  const raw = readValue(name);
  if (raw === undefined) return [...fallback];
  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part) && part >= 0);
  return parsed.length > 0 ? parsed : [...fallback];
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
