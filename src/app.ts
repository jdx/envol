import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";
import { CandidateNotFoundError, Store, now } from "./store.ts";
import { one } from "./db.ts";
import {
  configFromToml,
  type Artifact,
  type Candidate,
  type Line,
  type Publisher,
  type Project,
} from "./model.ts";
import { Engine } from "./engine.ts";
import type { Storage } from "./storage.ts";
import type { GitHubCredentials } from "./github.ts";
import { GitHub } from "./github.ts";
import { RequestError } from "./errors.ts";
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
const sessionName = "envol_session";
async function signSession(secret: string, timestamp: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(timestamp),
  );
  return Buffer.from(signature).toString("base64url");
}
async function validSession(secret: string, value?: string) {
  if (!secret || !value) return false;
  const [timestamp, signature, extra] = value.split(".");
  const issued = Number(timestamp);
  if (
    extra ||
    !Number.isSafeInteger(issued) ||
    issued > Date.now() ||
    Date.now() - issued > 12 * 60 * 60 * 1000
  )
    return false;
  return equal(signature ?? "", await signSession(secret, timestamp));
}
export function app(services: Services) {
  const api = new Hono(),
    { store, storage } = services,
    db = store.db;
  const engine = () => {
    if (!services.github)
      throw new RequestError("GitHub App credentials are not configured", 503);
    if (!services.releasesEnabled)
      throw new RequestError(
        "Release operations are disabled until repository onboarding is verified",
        409,
      );
    return new Engine({
      store,
      storage,
      credentials: services.github,
      url: services.url,
    });
  };
  api.onError((error, c) => {
    if (error instanceof CandidateNotFoundError)
      return c.json({ error: "Candidate not found" }, 404);
    if (error instanceof joseErrors.JOSEError)
      return c.json({ error: "Invalid workflow identity" }, 401);
    if (error instanceof SyntaxError)
      return c.json({ error: "Invalid request" }, 400);
    if (error instanceof RequestError)
      return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: "Internal server error" }, 500);
  });
  api.get("/health", (c) => c.json({ status: "ok", service: "envol" }));
  api.post("/api/auth/session", async (c) => {
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(services.url).origin)
      return c.json({ error: "Origin mismatch" }, 403);
    const body = await c.req.json<{ token?: string }>();
    if (!services.adminToken || !equal(body.token ?? "", services.adminToken))
      return c.json({ error: "Authentication required" }, 401);
    const timestamp = String(Date.now());
    setCookie(
      c,
      sessionName,
      `${timestamp}.${await signSession(services.adminToken, timestamp)}`,
      {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
        maxAge: 12 * 60 * 60,
      },
    );
    return c.json({ ok: true });
  });
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
    const bearer = services.adminToken && equal(token, services.adminToken);
    const cookie = await validSession(
      services.adminToken,
      getCookie(c, sessionName),
    );
    if (!bearer && !cookie)
      return c.json({ error: "Authentication required" }, 401);
    if (
      cookie &&
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      (c.req.header("Origin") !== new URL(services.url).origin ||
        c.req.header("X-Envol-CSRF") !== "1")
    )
      return c.json({ error: "CSRF validation failed" }, 403);
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
      throw new RequestError("Use owner/repository");
    if (!Number.isSafeInteger(body.installation_id) || body.installation_id < 1)
      throw new RequestError("GitHub App installation ID required");
    const config = configFromToml(body.config),
      id = crypto.randomUUID();
    if (!services.github)
      throw new RequestError(
        "Configure GitHub App before onboarding repositories",
        503,
      );
    const gh = await GitHub.installation(services.github, body.installation_id);
    const repository = await gh.request<{
      permissions?: { admin: boolean };
      private: boolean;
    }>(`/repos/${body.repo}`);
    if (body.public && repository.private)
      throw new RequestError("Private repositories cannot have public pages");
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
        throw new RequestError("Candidate is not ready", 409);
      await store.enqueue(candidate.id, "promote");
    } else if (action === "cancel") {
      if (["promoting", "publishing", "released"].includes(candidate.state))
        throw new RequestError("Publication has begun; resume instead", 409);
      candidate = await store.transition(candidate, "cancelling");
      await store.enqueue(candidate.id, "cancel");
    } else if (action === "retry") {
      const job = await one<{ kind: string }>(
        db,
        "SELECT kind FROM jobs WHERE candidate_id=? AND state='failed' ORDER BY rowid DESC LIMIT 1",
        [candidate.id],
      );
      if (!job) throw new RequestError("No failed job", 409);
      await store.enqueue(candidate.id, job.kind);
    } else throw new RequestError("Unknown action");
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
      throw new RequestError("Invalid artifact filename");
    const body = c.req.raw.body;
    if (!body) throw new RequestError("Artifact body required");
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
        throw new RequestError(
          "Artifact is immutable; create a new candidate",
          409,
        );
      return c.json(existing);
    }
    try {
      const inserted = await db.run(
        "INSERT INTO artifacts SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM candidates WHERE id=? AND state='building')",
        [id, name, digest, size, key, id],
      );
      if (!inserted)
        throw new RequestError("Candidate stopped accepting artifacts", 409);
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
      throw new RequestError("Required artifacts are missing", 409);
    await store.event(
      id,
      "build-complete",
      "All required artifacts uploaded; awaiting successful GitHub workflow conclusion",
    );
    // Reconciliation checks the actual workflow conclusion before marking ready.
    return c.json({ ok: true });
  });
  // Publication workflows can download retained bytes and report outcomes, but their
  // reports are informational. Only Envol's independent read-only checks publish rows.
  api.use("/api/publish/:id/*", async (c, next) => {
    const candidate = await store.candidate(c.req.param("id")!);
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "");
    if (!token) return c.json({ error: "OIDC token required" }, 401);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: "https://token.actions.githubusercontent.com",
      audience: services.url,
    });
    const context = await engine().context(candidate.id);
    if (
      candidate.state !== "publishing" ||
      payload.repository !== context.project.repo ||
      payload.sha !== candidate.sha ||
      payload.workflow_ref !== candidate.publish_workflow_ref ||
      payload.event_name !== "workflow_dispatch" ||
      typeof payload.run_id !== "string"
    )
      return c.json({ error: "Publication workflow identity mismatch" }, 403);
    const run = await context.gh.request<{
      head_sha: string;
      event: string;
    }>(`/repos/${context.project.repo}/actions/runs/${payload.run_id}`);
    if (run.head_sha !== candidate.sha || run.event !== "workflow_dispatch")
      return c.json({ error: "Publication run mismatch" }, 403);
    const changed = await db.run(
      "UPDATE candidates SET publish_run_id=? WHERE id=? AND (publish_run_id IS NULL OR publish_run_id=?)",
      [payload.run_id, candidate.id, payload.run_id],
    );
    if (!changed)
      return c.json(
        { error: "Candidate already bound to another publication run" },
        409,
      );
    await next();
  });
  api.get("/api/publish/:id/manifest", async (c) => {
    const candidate = await store.candidate(c.req.param("id"));
    const context = await engine().context(candidate.id);
    const artifacts = await db.all<Artifact>(
      "SELECT * FROM artifacts WHERE candidate_id=? ORDER BY name",
      [candidate.id],
    );
    return c.json({
      candidate: {
        id: candidate.id,
        version: candidate.version,
        tag: candidate.tag,
        sha: candidate.sha,
      },
      publishers: context.config.publishers,
      artifacts: artifacts.map(({ name, digest, size }) => ({
        name,
        digest,
        size,
        download_url: `${services.url.replace(/\/$/, "")}/api/publish/${encodeURIComponent(candidate.id)}/artifacts/${encodeURIComponent(name)}`,
      })),
    });
  });
  const streamArtifact = async (candidateId: string, name: string) => {
    const artifact = await one<Artifact>(
      db,
      "SELECT * FROM artifacts WHERE candidate_id=? AND name=?",
      [candidateId, name],
    );
    if (!artifact) return null;
    const object = await storage.get(artifact.storage_key);
    if (!object) return null;
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.size),
        "Content-Disposition": `attachment; filename="${artifact.name}"`,
      },
    });
  };
  api.get("/api/publish/:id/artifacts/:name", async (c) => {
    return (
      (await streamArtifact(c.req.param("id"), c.req.param("name"))) ??
      c.notFound()
    );
  });
  api.post("/api/publish/:id/report/:destination", async (c) => {
    const id = c.req.param("id"),
      destination = c.req.param("destination") as Publisher,
      candidate = await store.candidate(id),
      context = await engine().context(id);
    if (
      !["github", "crates"].includes(destination) ||
      !context.config.publishers.includes(destination)
    )
      throw new RequestError("Publisher is not configured", 404);
    if (candidate.state !== "publishing")
      throw new RequestError("Candidate is not publishing", 409);
    const body = await c.req.json<{
      status?: string;
      external_id?: string;
      error?: string;
    }>();
    if (!["success", "failure"].includes(body.status ?? ""))
      throw new RequestError("Report status must be success or failure");
    if (
      (body.external_id !== undefined &&
        (typeof body.external_id !== "string" ||
          body.external_id.length > 500)) ||
      (body.error !== undefined &&
        (typeof body.error !== "string" || body.error.length > 2000))
    )
      throw new RequestError("Publication report is too large");
    const changed = await db.run(
      "UPDATE publications SET state=?,external_id=?,error=? WHERE candidate_id=? AND destination=? AND state<>'published'",
      [
        body.status === "success" ? "reported" : "failed",
        body.external_id ?? null,
        body.status === "failure" ? (body.error ?? "Workflow failed") : null,
        id,
        destination,
      ],
    );
    if (!changed) throw new RequestError("Publication row is missing", 409);
    return c.json({ ok: true });
  });
  api.get("/api/admin/candidates/:id/artifacts/:name", async (c) => {
    return (
      (await streamArtifact(c.req.param("id"), c.req.param("name"))) ??
      c.notFound()
    );
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
    "SELECT * FROM projects ORDER BY id",
  );
  const cursor = await one<{ value: string }>(
    services.store.db,
    "SELECT value FROM runtime_state WHERE key='metrics_cursor'",
  );
  const start = cursor
    ? Math.max(
        0,
        projects.findIndex((project) => project.id === cursor.value) + 1,
      )
    : 0;
  const rotated = [...projects.slice(start), ...projects.slice(0, start)];
  // Stay below the Workers Free request ceiling, leaving headroom for platform work.
  let remaining = 45;
  for (const project of rotated) {
    const authCost = services.github && project.installation_id > 0 ? 1 : 0;
    if (remaining < authCost + 2) break;
    remaining -= authCost;
    try {
      const gh = await githubForMetrics(services, project);
      remaining--;
      const repo = await gh.request<{ stargazers_count: number }>(
        `/repos/${project.repo}`,
      );
      let downloads = 0,
        page = 1,
        complete = false;
      while (remaining > 0) {
        remaining--;
        const releases = await gh.request<
          { assets: { download_count: number }[] }[]
        >(`/repos/${project.repo}/releases?per_page=100&page=${page++}`);
        for (const release of releases)
          for (const asset of release.assets) downloads += asset.download_count;
        if (releases.length < 100) {
          complete = true;
          break;
        }
      }
      const values = complete
        ? { stars: repo.stargazers_count, downloads }
        : { stars: repo.stargazers_count };
      for (const [metric, value] of Object.entries(values))
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
    await services.store.db.run(
      "INSERT INTO runtime_state VALUES('metrics_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [project.id],
    );
  }
}

export async function githubForMetrics(services: Services, project: Project) {
  return services.github && project.installation_id > 0
    ? GitHub.installation(services.github, project.installation_id)
    : new GitHub("");
}
