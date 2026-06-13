import type { DocumentByName, GenericDataModel, TableNamesInDataModel } from "convex/server";
import type { GenericId } from "convex/values";

/**
 * Convex data model helper types re-exported for internal runtime typing.
 *
 * @internal
 */
export type { GenericDataModel, TableNamesInDataModel } from "convex/server";

/**
 * Convex document id type.
 *
 * @internal
 */
export type Id<TableName extends string> = GenericId<TableName>;

/**
 * Convex document type by table name.
 *
 * @internal
 */
export type Doc<DM extends GenericDataModel, T extends TableNamesInDataModel<DM>> = DocumentByName<
  DM,
  T
>;
