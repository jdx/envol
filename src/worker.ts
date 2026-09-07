import { app, collectMetrics, type Services } from "./app.ts";
import { D1Store } from "./db.ts";
import { R2Storage } from "./storage.ts";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  ASSETS: Fetcher;
  ENVOL_URL: string;
  ENVOL_ADMIN_TOKEN: string;
  ENVOL_RELEASES_ENABLED?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
}
function services(env: Env): Services {
  return {
    store: new Store(new D1Store(env.DB)),
    storage: new R2Storage(env.ARTIFACTS),
    url: env.ENVOL_URL,
    adminToken: env.ENVOL_ADMIN_TOKEN,
    releasesEnabled: env.ENVOL_RELEASES_ENABLED === "true",
    github:
      env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY
        ? { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY }
        : undefined,
    assets: (request) => env.ASSETS.fetch(request),
  };
}
export default {
  fetch(request: Request, env: Env) {
    return app(services(env)).fetch(request);
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    const s = services(env);
    if (s.github && s.releasesEnabled) {
      const e = new Engine({
        store: s.store,
        storage: s.storage,
        credentials: s.github,
        url: s.url,
      });
      ctx.waitUntil(
        (async () => {
          await e.reconcileBuilds();
          await e.runOne();
        })(),
      );
    }
    if (new Date().getUTCHours() === 0 && new Date().getUTCMinutes() < 5)
      ctx.waitUntil(collectMetrics(s));
  },
};
