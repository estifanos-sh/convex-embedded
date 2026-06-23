import embedded from "@convex-dev/embedded/convex.config";
import migrations from "@convex-dev/migrations/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(embedded);
app.use(migrations);

export default app;
