import { ActivityTab } from "./activity";
import { DataTab } from "./data";
import { FunctionsTab } from "./functions";
import { SchedulerTab } from "./scheduler";
import { StorageTab } from "./storage";
import type { DevtoolsTab } from "../tab";

export const tabs: DevtoolsTab[] = [
  { id: "activity", label: "Activity", component: ActivityTab },
  { id: "data", label: "Data", component: DataTab },
  { id: "storage", label: "Storage", component: StorageTab },
  { id: "scheduler", label: "Scheduler", component: SchedulerTab },
  { id: "functions", label: "Functions", component: FunctionsTab },
];
