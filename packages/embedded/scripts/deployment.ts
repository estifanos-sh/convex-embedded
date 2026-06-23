import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { EMBEDDED_PROTOCOL_VERSION } from "../src/protocol.ts";

const pull = makeFunctionReference<
  "query",
  { request: { kind: "identity" } },
  { identity: unknown; identityKey: string; protocolVersion?: number }
>("embedded:pull");

export async function verifyDeployment(packageDir: string): Promise<void> {
  const repoRoot = resolve(packageDir, "../..");
  const remoteUrl = readEnv(repoRoot, "VITE_CONVEX_URL");
  if (!remoteUrl) {
    throw new Error("VITE_CONVEX_URL must select the deployment used by hosted browser tests.");
  }

  const url = new URL(remoteUrl);
  if (url.protocol !== "https:") {
    throw new Error(`Hosted browser tests require an HTTPS Convex URL, received ${remoteUrl}.`);
  }
  const deployment = readEnv(repoRoot, "CONVEX_DEPLOYMENT");
  if (deployment) verifyDeploymentUrl(deployment, url);

  const identity = await new ConvexHttpClient(url.origin).query(pull, {
    request: { kind: "identity" },
  });
  if (identity.protocolVersion !== EMBEDDED_PROTOCOL_VERSION) {
    const received = identity.protocolVersion ?? "missing";
    throw new Error(
      `Embedded deployment mismatch at ${url.origin}: client protocol ${EMBEDDED_PROTOCOL_VERSION}, deployment protocol ${received}. Deploy this revision before running hosted browser tests.`,
    );
  }

  console.log(
    `Verified Embedded deployment ${url.origin} at protocol ${EMBEDDED_PROTOCOL_VERSION}.`,
  );
}

function verifyDeploymentUrl(deployment: string, url: URL): void {
  const name = deployment.includes(":")
    ? deployment.slice(deployment.indexOf(":") + 1)
    : deployment;
  if (!url.hostname.startsWith(`${name}.`)) {
    throw new Error(
      `CONVEX_DEPLOYMENT ${deployment} does not match VITE_CONVEX_URL ${url.origin}.`,
    );
  }
}

function readEnv(repoRoot: string, name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  try {
    const contents = readFileSync(resolve(repoRoot, ".env.local"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 0 || trimmed.slice(0, separator).trim() !== name) continue;
      return (
        trimmed
          .slice(separator + 1)
          .trim()
          .replace(/\s+#.*$/, "")
          .replace(/^['"]|['"]$/g, "") || undefined
      );
    }
  } catch {
    return undefined;
  }
  return undefined;
}
