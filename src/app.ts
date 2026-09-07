import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";
import { Store, now } from "./store.ts";
import { one } from "./db.ts";
import {
  configFromToml,
  type Artifact,
  type Candidate,
  type Line,
  type Project,
} from "./model.ts";
import { Engine } from "./engine.ts";
import type { Storage } from "./storage.ts";
import type { GitHubCredentials } from "./github.ts";
import { GitHub } from "./github.ts";
export interface Services {
  store: Store;
  storage: Storage;
  adminToken: string;
  url: string;
  github?: GitHubCredentials;
  releasesEnabled?: boolean;
  assets?: (request: Request) => Promise<Response>;
}
const jwks = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
);
function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function app(services: Services) {
  const api = new Hono(),
    { store, storage } = services,
    db = store.db;
  const engine = () => {
    if (!services.github)
      throw new Error("GitHub App credentials are not configured");
    if (!services.releasesEnabled)
      throw new Error(
        "Release operations are disabled until repository onboarding is verified",
      );
    return new Engine({
      store,
      storage,
      credentials: services.github,
      url: services.url,
    });
  };
  api.onError((error, c) => {
    console.error(error);
    return c.json({ error: error.message }, 400);
  });
  api.get("/health", (c) => c.json({ status: "ok", service: "envol" }));
  api.get("/api/public/projects", async (c) =>
    c.json(
      await db.all(
        "SELECT id,repo,created_at FROM projects WHERE public=1 ORDER BY repo",
      ),
    ),
  );
  api.get("/api/public/projects/:id", async (c) => {
    const project = await one<Project>(
      db,
      "SELECT * FROM projects WHERE id=? AND public=1",
      [c.req.param("id")],
    );
    if (!project) return c.json({ error: "Not found" }, 404);
    const releases = await db.all(
      "SELECT c.version,c.tag,c.updated_at FROM candidates c JOIN lines l ON l.id=c.line_id WHERE l.project_id=? AND c.state='released' ORDER BY c.updated_at DESC",
      [project.id],
    );
    const metrics = await db.all(
      "SELECT source,metric,day,value FROM metrics WHERE project_id=? ORDER BY day",
      [project.id],
    );
    return c.json({
      project: { id: project.id, repo: project.repo },
      releases,
      metrics,
    });
  });
  api.use("/api/admin/*", async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
    if (!services.adminToken || !equal(token, services.adminToken))
      return c.json({ error: "Authentication required" }, 401);
    await next();
  });
  api.get("/api/admin/overview", async (c) =>
    c.json({
      projects: await db.all("SELECT * FROM projects ORDER BY repo"),
      lines: await db.all("SELECT * FROM lines ORDER BY name"),
      candidates: await db.all(
        "SELECT * FROM candidates ORDER BY created_at DESC LIMIT 100",
      ),
      metrics: await db.all(
        "SELECT * FROM metrics ORDER BY day DESC LIMIT 1000",
      ),
      configured: !!services.github,
    }),
  );
  api.post("/api/admin/projects", async (c) => {
    const body = await c.req.json();
    if (typeof body.repo !== "string" || !/^[-\w.]+\/[-\w.]+$/.test(body.repo))
      throw new Error("Use owner/repository");
    if (!Number.isSafeInteger(body.installation_id) || body.installation_id < 1)
      throw new Error("GitHub App installation ID required");
    const config = configFromToml(body.config),
      id = crypto.randomUUID();
    if (!services.github)
      throw new Error("Configure GitHub App before onboarding repositories");
    const gh = await GitHub.installation(services.github, body.installation_id);
    const repository = await gh.request<{
      permissions?: { admin: boolean };
      private: boolean;
    }>(`/repos/${body.repo}`);
    if (body.public && repository.private)
      throw new Error("Private repositories cannot have public pages");
    // Read every source ref now; reject invalid configuration before inserting anything.
    for (const line of Object.values(config.lines))
      await gh.head(body.repo, line.branch);
    await db.batch([
      {
        sql: "INSERT INTO projects VALUES(?,?,?,?,?,?)",
        params: [
          id,
          body.repo,
          body.installation_id,
          body.public ? 1 : 0,
          JSON.stringify(config),
          now(),
        ],
      },
      ...Object.entries(config.lines).map(([name, line]) => ({
        sql: "INSERT INTO lines(id,project_id,name,branch,channel) VALUES(?,?,?,?,?)",
        params: [crypto.randomUUID(), id, name, line.branch, line.channel],
      })),
    ]);
    return c.json({ id }, 201);
  });
  api.post("/api/admin/lines/:id/candidates", async (c) => {
    engine();
    const line = await one<Line>(db, "SELECT * FROM lines WHERE id=?", [
      c.req.param("id"),
    ]);
    if (!line) return c.json({ error: "Line not found" }, 404);
    const body = await c.req.json();
    return c.json(
      await store.create(
        line,
        body.version,
        c.req.header("Idempotency-Key") ?? "",
      ),
      201,
    );
  });
  api.get("/api/admin/candidates/:id", async (c) => {
    const candidate = await store.candidate(c.req.param("id"));
    return c.json({
      candidate,
      artifacts: await db.all("SELECT * FROM artifacts WHERE candidate_id=?", [
        candidate.id,
      ]),
      events: await db.all(
        "SELECT * FROM events WHERE candidate_id=? ORDER BY id",
        [candidate.id],
      ),
      publications: await db.all(
        "SELECT * FROM publications WHERE candidate_id=?",
        [candidate.id],
      ),
      jobs: await db.all("SELECT * FROM jobs WHERE candidate_id=?", [
        candidate.id,
      ]),
    });
  });
  api.post("/api/admin/candidates/:id/:action", async (c) => {
    let candidate = await store.candidate(c.req.param("id"));
    const action = c.req.param("action");
    if (action === "promote") {
      if (candidate.state !== "ready")
        throw new Error("Candidate is not ready");
      await store.enqueue(candidate.id, "promote");
    } else if (action === "cancel") {
      if (["promoting", "publishing", "released"].includes(candidate.state))
        throw new Error("Publication has begun; resume instead");
      candidate = await store.transition(candidate, "cancelling");
      await store.enqueue(candidate.id, "cancel");
    } else if (action === "retry") {
      const job = await one<{ kind: string }>(
        db,
        "SELECT kind FROM jobs WHERE candidate_id=? AND state='failed' ORDER BY rowid DESC LIMIT 1",
        [candidate.id],
      );
      if (!job) throw new Error("No failed job");
      await store.enqueue(candidate.id, job.kind);
    } else throw new Error("Unknown action");
    return c.json({ ok: true });
  });
  api.post("/api/admin/tick", async (c) => {
    const e = engine();
    await e.reconcileBuilds();
    return c.json({ processed: await e.runOne() });
  });
  api.post("/api/admin/metrics/refresh", async (c) => {
    await collectMetrics(services);
    return c.json({ ok: true });
  });
  // Workflow identities are bound to the exact repository, candidate SHA, workflow and run.
  api.use("/api/runs/:id/*", async (c, next) => {
    const candidate = await store.candidate(c.req.param("id")!);
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "");
    if (!token) return c.json({ error: "OIDC token required" }, 401);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: "https://token.actions.githubusercontent.com",
      audience: services.url,
    });
    const context = await engine().context(candidate.id);
    if (
      payload.repository !== context.project.repo ||
      payload.sha !== candidate.sha ||
      payload.workflow_ref !== candidate.workflow_ref ||
      payload.event_name !== "workflow_dispatch" ||
      typeof payload.run_id !== "string"
    )
      return c.json({ error: "Workflow identity mismatch" }, 403);
    if (candidate.state !== "building")
      return c.json(
        { error: "Candidate no longer accepts build results" },
        409,
      );
    const run = await context.gh.request<{ head_sha: string; event: string }>(
      `/repos/${context.project.repo}/actions/runs/${payload.run_id}`,
    );
    if (run.head_sha !== candidate.sha || run.event !== "workflow_dispatch")
      return c.json({ error: "Run mismatch" }, 403);
    const changed = await db.run(
      "UPDATE candidates SET run_id=? WHERE id=? AND (run_id IS NULL OR run_id=?)",
      [payload.run_id, candidate.id, payload.run_id],
    );
    if (!changed)
      return c.json(
        { error: "Candidate already bound to another workflow run" },
        409,
      );
    await next();
  });
  api.put("/api/runs/:id/artifacts/:name", async (c) => {
    const id = c.req.param("id"),
      name = c.req.param("name");
    if (!/^[-\w.]+$/.test(name) || name.length > 200)
      throw new Error("Invalid artifact filename");
    const body = c.req.raw.body;
    if (!body) throw new Error("Artifact body required");
    const key = `candidates/${id}/${crypto.randomUUID()}/${name}`;
    const hash = createHash("sha256");
    let size = 0;
    const stream = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          hash.update(chunk);
          size += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    );
    await storage.put(key, stream);
    const digest = hash.digest("hex");
    const existing = await one<Artifact>(
      db,
      "SELECT * FROM artifacts WHERE candidate_id=? AND name=?",
      [id, name],
    );
    if (existing) {
      await storage.delete(key);
      if (existing.digest !== digest || existing.size !== size)
        throw new Error("Artifact is immutable; create a new candidate");
      return c.json(existing);
    }
    try {
      const inserted = await db.run(
        "INSERT INTO artifacts SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM candidates WHERE id=? AND state='building')",
        [id, name, digest, size, key, id],
      );
      if (!inserted) throw new Error("Candidate stopped accepting artifacts");
    } catch (e) {
      await storage.delete(key);
      throw e;
    }
    return c.json({ name, digest, size }, 201);
  });
  api.post("/api/runs/:id/complete", async (c) => {
    const id = c.req.param("id"),
      context = await engine().context(id);
    const artifacts = await db.all<Artifact>(
      "SELECT * FROM artifacts WHERE candidate_id=?",
      [id],
    );
    if (
      context.config.required_artifacts.some(
        (name) => !artifacts.some((a) => a.name === name),
      )
    )
      throw new Error("Required artifacts are missing");
    await store.event(
      id,
      "build-complete",
      "All required artifacts uploaded; awaiting successful GitHub workflow conclusion",
    );
    // Reconciliation checks the actual workflow conclusion before marking ready.
    return c.json({ ok: true });
  });
  api.get("/api/admin/candidates/:id/artifacts/:name", async (c) => {
    const artifact = await one<Artifact>(
      db,
      "SELECT * FROM artifacts WHERE candidate_id=? AND name=?",
      [c.req.param("id"), c.req.param("name")],
    );
    if (!artifact) return c.notFound();
    const object = await storage.get(artifact.storage_key);
    if (!object) return c.notFound();
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.size),
        "Content-Disposition": `attachment; filename="${artifact.name}"`,
      },
    });
  });
  api.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  api.get("*", (c) =>
    services.assets
      ? services.assets(c.req.raw)
      : c.text("Run npm run build to build the Envol dashboard."),
  );
  return api;
}
export async function collectMetrics(services: Services) {
  const projects = await services.store.db.all<Project>(
    "SELECT * FROM projects",
  );
  for (const project of projects) {
    try {
      const gh = await githubForMetrics(services, project);
      const repo = await gh.request<{ stargazers_count: number }>(
        `/repos/${project.repo}`,
      );
      let downloads = 0,
        page = 1;
      while (true) {
        const releases = await gh.request<
          { assets: { download_count: number }[] }[]
        >(`/repos/${project.repo}/releases?per_page=100&page=${page++}`);
        for (const release of releases)
          for (const asset of release.assets) downloads += asset.download_count;
        if (releases.length < 100) break;
      }
      for (const [metric, value] of Object.entries({
        stars: repo.stargazers_count,
        downloads,
      }))
        await services.store.db.run(
          "INSERT INTO metrics VALUES(?,?,?,?,?) ON CONFLICT(project_id,source,metric,day) DO UPDATE SET value=excluded.value",
          [project.id, "github", metric, now().slice(0, 10), value],
        );
    } catch (error) {
      console.error(
        `Could not collect GitHub metrics for ${project.repo}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export async function githubForMetrics(services: Services, project: Project) {
  return services.github && project.installation_id > 0
    ? GitHub.installation(services.github, project.installation_id)
    : new GitHub("");
}
