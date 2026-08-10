import {
  CURRENT_WIRE_CONTRACT_ID,
  WIRE_ERROR_PROTOCOL_MISMATCH,
  type WireContractId,
} from "./contract/generated";

export { CURRENT_WIRE_CONTRACT_ID, type WireContractId } from "./contract/generated";

export function isWireContractId(value: string): value is WireContractId {
  return value === CURRENT_WIRE_CONTRACT_ID;
}

/** Selects an explicitly offered, exact contract. */
export function selectWireContractId(
  offered: readonly string[] | undefined,
): WireContractId | undefined {
  return offered?.includes(CURRENT_WIRE_CONTRACT_ID) ? CURRENT_WIRE_CONTRACT_ID : undefined;
}

export const EMBEDDED_PROTOCOL_MISMATCH = WIRE_ERROR_PROTOCOL_MISMATCH;
export const EMBEDDED_CLIENT_RETIRED = "EMBEDDED_CLIENT_RETIRED";
export const EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY = "unauthenticated";
