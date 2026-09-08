import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { SQLiteStore } from "./sqlite.ts";
import { LocalStorage } from "./local-storage.ts";
import { Store } from "./store.ts";
import { app, type Services } from "./app.ts";
import { Engine } from "./engine.ts";
const dir = resolve(process.env.ENVOL_DATA_DIR ?? "data");
await mkdir(dir, { recursive: true });
const db = new SQLiteStore(resolve(dir, "envol.sqlite"));
db.raw.exec(
  "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
);
const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
  .filter((name) => name.endsWith(".sql"))
  .sort();
for (const name of migrations) {
  if (db.raw.prepare("SELECT 1 FROM schema_migrations WHERE name=?").get(name))
    continue;
  db.raw.exec("BEGIN");
  try {
    db.raw.exec(
      await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    );
    db.raw
      .prepare("INSERT INTO schema_migrations VALUES(?,?)")
      .run(name, new Date().toISOString());
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
}
const staticApp = new Hono()
  .use("*", serveStatic({ root: "./dist" }))
  .get("*", serveStatic({ path: "./dist/index.html" }));
const port = Number(process.env.PORT ?? 8787);
const services: Services = {
  store: new Store(db),
  storage: new LocalStorage(resolve(dir, "artifacts")),
  adminToken: process.env.ENVOL_ADMIN_TOKEN ?? "",
  url: process.env.ENVOL_URL ?? `http://localhost:${port}`,
  github:
    process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY
      ? {
          appId: process.env.GITHUB_APP_ID,
          privateKey: process.env.GITHUB_PRIVATE_KEY,
        }
      : undefined,
  assets: async (req) => staticApp.fetch(req),
};
if (!services.adminToken)
  console.warn(
    "ENVOL_ADMIN_TOKEN is unset. Admin API is disabled; public pages remain available.",
  );
serve(
  {
    fetch: app(services).fetch,
    port,
    hostname: process.env.HOST ?? "127.0.0.1",
  },
  () => console.log(`Envol listening at http://localhost:${port}`),
);
services.releasesEnabled = process.env.ENVOL_RELEASES_ENABLED === "true";
if (services.github && services.releasesEnabled) {
  const engine = new Engine({
    store: services.store,
    storage: services.storage,
    credentials: services.github,
    url: services.url,
  });
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await engine.reconcileBuilds();
      await engine.runOne();
    } catch (e) {
      console.error(e);
    } finally {
      running = false;
    }
  }, 5000);
}
