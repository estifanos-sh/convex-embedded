import { defineApp } from "convex/server";
import embedded from "@convex-dev/embedded/convex.config";
import migrations from "@convex-dev/migrations/convex.config.js";
import staticHosting from "@convex-dev/static-hosting/convex.config";

const app = defineApp();
app.use(embedded);
app.use(migrations);
app.use(staticHosting, { name: "staticHosting" });

export default app;
