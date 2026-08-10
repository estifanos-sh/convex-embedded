import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { deploymentUrl } from "../../../config/deployment.ts";
import { convexDeployment } from "../../../config/env.ts";
import { repoRoot } from "../../../config/read.ts";
import { CURRENT_WIRE_CONTRACT_ID } from "../src/contract/generated.ts";

const pull = makeFunctionReference<
  "query",
  { request: { kind: "identity"; contractIds: string[] } },
  { identity: unknown; identityKey: string; contractId?: string }
>("embedded:pull");

export async function verifyDeployment(): Promise<void> {
  const remoteUrl = deploymentUrl(repoRoot);
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
    request: { kind: "identity", contractIds: [CURRENT_WIRE_CONTRACT_ID] },
  });
  if (identity.contractId !== CURRENT_WIRE_CONTRACT_ID) {
    const received = identity.contractId ?? "missing";
    throw new Error(
      `Embedded deployment mismatch at ${url.origin}: client contract ${CURRENT_WIRE_CONTRACT_ID}, deployment contract ${received}. Deploy this revision before running hosted browser tests.`,
    );
  }

  console.log(
    `Verified Embedded deployment ${url.origin} at contract ${CURRENT_WIRE_CONTRACT_ID}.`,
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
