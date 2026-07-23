import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { convexDeployment, convexUrl } from "../../../config/env.ts";
import { EMBEDDED_PROTOCOL_VERSION } from "../src/protocol.ts";

const pull = makeFunctionReference<
  "query",
  { request: { kind: "identity" } },
  { identity: unknown; identityKey: string; protocolVersion?: number }
>("embedded:pull");

export async function verifyDeployment(): Promise<void> {
  const remoteUrl = convexUrl();
  if (!remoteUrl) {
    throw new Error("VITE_CONVEX_URL must select the deployment used by hosted browser tests.");
  }

  const url = new URL(remoteUrl);
  if (url.protocol !== "https:") {
    throw new Error(`Hosted browser tests require an HTTPS Convex URL, received ${remoteUrl}.`);
  }
  const deployment = convexDeployment();
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
