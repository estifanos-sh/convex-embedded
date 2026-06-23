/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crdt from "../crdt.js";
import type * as crdt_checkpoint from "../crdt/checkpoint.js";
import type * as crdt_field from "../crdt/field.js";
import type * as crdt_payload from "../crdt/payload.js";
import type * as file from "../file.js";
import type * as identity from "../identity.js";
import type * as local from "../local.js";
import type * as model from "../model.js";
import type * as mutation from "../mutation.js";
import type * as protocol from "../protocol.js";
import type * as remote_client from "../remote/client.js";
import type * as rev from "../rev.js";
import type * as settlement from "../settlement.js";
import type * as time from "../time.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  crdt: typeof crdt;
  "crdt/checkpoint": typeof crdt_checkpoint;
  "crdt/field": typeof crdt_field;
  "crdt/payload": typeof crdt_payload;
  file: typeof file;
  identity: typeof identity;
  local: typeof local;
  model: typeof model;
  mutation: typeof mutation;
  protocol: typeof protocol;
  "remote/client": typeof remote_client;
  rev: typeof rev;
  settlement: typeof settlement;
  time: typeof time;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<typeof fullApi, FunctionReference<any, "public">> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
