import type { DocumentByName, GenericDataModel, TableNamesInDataModel } from "convex/server";
import type { GenericId } from "convex/values";

export type { GenericDataModel, TableNamesInDataModel } from "convex/server";

export type Id<TableName extends string> = GenericId<TableName>;

export type Doc<DM extends GenericDataModel, T extends TableNamesInDataModel<DM>> = DocumentByName<
  DM,
  T
>;
