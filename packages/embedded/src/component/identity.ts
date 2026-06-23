import { hashValue } from "../hash";

export type IdentitySelector = { tokenIdentifier: string } | { identityKey: string };

export async function identityKey(selector: IdentitySelector): Promise<string> {
  return "identityKey" in selector
    ? selector.identityKey
    : await hashValue(selector.tokenIdentifier);
}
