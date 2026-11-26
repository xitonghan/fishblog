import { Hono } from "hono";
import type { Env } from "./types.ts";
import { autoMigrate } from "./db/migrate.ts";
import blog from "./routes/blog.ts";
import admin from "./routes/admin.ts";
import api from "./routes/api.ts";

const app = new Hono<{ Bindings: Env }>();

// Run schema checks once per isolate instead of on every request. The check is
// idempotent; a fresh isolate after a deploy picks up any new migrations.
let migrationDone: Promise<void> | undefined;
app.use("*", async (c, next) => {
  if (!migrationDone) {
    migrationDone = autoMigrate(c.env.DB).catch((err) => {
      migrationDone = undefined; // allow retry if the first attempt failed
      throw err;
    });
  }
  await migrationDone;
  await next();
});

app.route("/api", api);
app.route("/admin", admin);
app.route("/", blog);

export default app;
