import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteStore } from "../src/sqlite.ts";
import { D1Store, type Database } from "../src/db.ts";
import { Store } from "../src/store.ts";
import {
  configFromToml,
  releaseVersion,
  nextVersion,
  type Line,
} from "../src/model.ts";
import { LocalStorage } from "../src/local-storage.ts";
import { bumpFile, Engine } from "../src/engine.ts";
import { app, collectMetrics, githubForMetrics } from "../src/app.ts";
import { GitHub } from "../src/github.ts";
import { milestone } from "../src/metrics.ts";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const schema = await readFile(
  new URL("../migrations/0001_initial.sql", import.meta.url),
  "utf8",
);
const runtimeStateMigration = await readFile(
  new URL("../migrations/0002_runtime_state.sql", import.meta.url),
  "utf8",
);
async function exercise(db: Database) {
  await db.run("INSERT INTO projects VALUES(?,?,?,?,?,?)", [
    "p",
    "test/cli",
    1,
    0,
    "{}",
    new Date().toISOString(),
  ]);
  await db.run(
    "INSERT INTO lines(id,project_id,name,branch,channel) VALUES(?,?,?,?,?)",
    ["l", "p", "stable", "main", "stable"],
  );
  const line = (await db.all<Line>("SELECT * FROM lines"))[0],
    store = new Store(db);
  const first = await store.create(line, "1.0.0", "request");
  assert.equal((await store.create(line, "1.0.0", "request")).id, first.id);
  await assert.rejects(
    () => store.create(line, "2.0.0", "request"),
    /another version/,
  );
  await assert.rejects(() => store.create(line, "1.0.1", "other"));
  const claims = await Promise.all([store.claim(), store.claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const job = claims.find(Boolean)!;
  assert.equal(await store.finish(job.id, job.fence - 1), false);
  assert.equal(
    (await db.all<{ state: string }>("SELECT state FROM jobs"))[0].state,
    "running",
  );
  assert.equal(await store.finish(job.id, job.fence), true);
  assert.equal(
    (await db.all<{ state: string }>("SELECT state FROM jobs"))[0].state,
    "done",
  );
  const preparing = await store.transition(first, "preparing");
  await assert.rejects(
    () => store.transition(first, "cancelling"),
    /concurrently/,
  );
  await assert.rejects(
    () => store.transition(preparing, "released"),
    /Invalid transition/,
  );
  const cancelling = await store.transition(preparing, "cancelling");
  await store.transition(cancelling, "cancelled");
  assert.equal((await store.create(line, "1.0.1", "next")).state, "queued");
  await assert.rejects(() =>
    db.batch([
      {
        sql: "INSERT INTO deliveries VALUES(?,?)",
        params: ["duplicate", "now"],
      },
      {
        sql: "INSERT INTO deliveries VALUES(?,?)",
        params: ["duplicate", "now"],
      },
    ]),
  );
  assert.equal(
    (await db.all("SELECT * FROM deliveries")).length,
    0,
    "batch must roll back atomically",
  );
}
test("SQLite: idempotency, line locks, leases, optimistic transitions, atomic batches", async () => {
  const db = new SQLiteStore(":memory:");
  try {
    db.raw.exec(schema);
    await exercise(db);
  } finally {
    db.close();
  }
});
test("D1: same release contracts as SQLite", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "test",
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          compatibilityDate: "2026-09-07",
          d1Databases: ["DB"],
        },
      ],
    }),
  );
  try {
    const db = await mf.getD1Database("DB", "test");
    for (const sql of schema.split(";").filter((s) => s.trim()))
      await db.prepare(sql).run();
    await exercise(new D1Store(db as unknown as D1Database));
  } finally {
    await mf.dispose();
  }
});
test("runtime cursor migration upgrades databases created before cursors", async () => {
  const db = new SQLiteStore(":memory:");
  try {
    db.raw.exec(
      schema.replace(/CREATE TABLE IF NOT EXISTS runtime_state[^;]+;/, ""),
    );
    assert.throws(() => db.raw.prepare("SELECT * FROM runtime_state").all());
    db.raw.exec(runtimeStateMigration);
    await db.run("INSERT INTO runtime_state VALUES(?,?)", [
      "cursor",
      "project",
    ]);
    const rows = await db.all<{ key: string; value: string }>(
      "SELECT * FROM runtime_state",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, "cursor");
    assert.equal(rows[0].value, "project");
  } finally {
    db.close();
  }
});
test("version policy prevents stable prereleases and wrong channels", () => {
  assert.equal(releaseVersion("1.2.3", "stable"), "1.2.3");
  assert.equal(releaseVersion("2.0.0-rc.1", "rc"), "2.0.0-rc.1");
  for (const v of ["latest", "v1.2.3", "1.2", "1.2.3+build", "2.0.0-alpha.1"])
    assert.throws(() => releaseVersion(v, "stable"));
  assert.throws(() => releaseVersion("2.0.0-alpha.1", "beta"));
  assert.equal(nextVersion("1.2.3", "major", "alpha"), "2.0.0-alpha.1");
  assert.equal(nextVersion("2.0.0-alpha.1", "minor", "alpha"), "2.1.0-alpha.1");
});
test("configuration validates paths, release lines and exact artifact inventory", async () => {
  const source = await readFile(
    new URL("../envol.toml", import.meta.url),
    "utf8",
  );
  assert.equal(configFromToml(source).lines.stable.branch, "main");
  assert.throws(() =>
    configFromToml(source.replace('"Cargo.toml"', '"../Cargo.toml"')),
  );
  assert.throws(() =>
    configFromToml(source + '\n[lines.other]\nbranch="main"\nchannel="beta"'),
  );
});
test("version edits support Cargo workspaces and package.json", () => {
  const cargo =
    '# keep me\n[workspace.package] # also me\nversion = "0.1.0" # pinned\n';
  assert.equal(
    bumpFile("Cargo.toml", cargo, "2.0.0"),
    '# keep me\n[workspace.package] # also me\nversion = "2.0.0" # pinned\n',
  );
  assert.equal(
    JSON.parse(bumpFile("package.json", '{"version":"1.0.0"}', "2.0.0"))
      .version,
    "2.0.0",
  );
  assert.throws(() =>
    bumpFile("Cargo.toml", '[package]\nname="test"', "2.0.0"),
  );
});

test("milestones use the nearest point before the trailing cutoff", () => {
  assert.deepEqual(
    milestone([
      { day: "2026-01-01", value: 100 },
      { day: "2026-01-20", value: 120 },
      { day: "2026-02-02", value: 132 },
    ]),
    {
      target: 200,
      current: 132,
      asOf: "2026-02-02",
      days: 68,
      method:
        "Projection based on the trailing 30-day net growth rate; growth can change.",
    },
  );
});
test("local artifacts stream and reject path traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "envol-test-"));
  try {
    const storage = new LocalStorage(dir);
    await storage.put("candidate/file", new Blob(["release bytes"]).stream());
    const object = await storage.get("candidate/file");
    assert.equal(await new Response(object?.body).text(), "release bytes");
    await assert.rejects(() =>
      storage.put("../escape", new Blob(["bad"]).stream()),
    );
    assert.equal(await storage.get("missing"), null);
    await storage.delete("candidate/file");
    assert.equal(await storage.get("candidate/file"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("public API never exposes private projects or candidate artifacts", async () => {
  const db = new SQLiteStore(":memory:");
  const dir = await mkdtemp(join(tmpdir(), "envol-api-"));
  try {
    db.raw.exec(schema);
    await db.run("INSERT INTO projects VALUES(?,?,?,?,?,?)", [
      "private",
      "owner/secret",
      1,
      0,
      "{}",
      "now",
    ]);
    await db.run("INSERT INTO projects VALUES(?,?,?,?,?,?)", [
      "public",
      "owner/open",
      1,
      1,
      "{}",
      "now",
    ]);
    const api = app({
      store: new Store(db),
      storage: new LocalStorage(dir),
      adminToken: "secret-token",
      url: "https://envol.test",
    });
    assert.equal((await api.request("/api/admin/overview")).status, 401);
    const publicProjects = (await (
      await api.request("/api/public/projects")
    ).json()) as { repo: string }[];
    assert.deepEqual(
      publicProjects.map((p: any) => p.repo),
      ["owner/open"],
    );
    assert.equal(
      (await api.request("/api/public/projects/private")).status,
      404,
    );
    const overview = await api.request("/api/admin/overview", {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(overview.status, 200);
    assert.equal(
      ((await overview.json()) as { projects: unknown[] }).projects.length,
      2,
    );
    const invalidProject = await api.request("/api/admin/projects", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repo: "invalid", installation_id: 1 }),
    });
    assert.equal(invalidProject.status, 400);
    assert.deepEqual(await invalidProject.json(), {
      error: "Use owner/repository",
    });
    assert.equal(
      (await api.request("/api/admin/candidates/x/artifacts/y")).status,
      401,
    );
    const login = await api.request("/api/auth/session", {
      method: "POST",
      headers: {
        Origin: "https://envol.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: "secret-token" }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("Set-Cookie")!;
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.doesNotMatch(setCookie, /secret-token/);
    const cookie = setCookie.split(";", 1)[0];
    assert.equal(
      (
        await api.request("/api/admin/overview", {
          headers: { Cookie: cookie },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await api.request("/api/admin/candidates/missing/retry", {
          method: "POST",
          headers: { Cookie: cookie },
        })
      ).status,
      403,
    );
    const missing = await api.request("/api/admin/candidates/missing", {
      headers: { Cookie: cookie },
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Candidate not found" });
    await db.run(
      "INSERT INTO lines(id,project_id,name,branch,channel) VALUES(?,?,?,?,?)",
      ["run-line", "public", "stable", "main", "stable"],
    );
    await db.run(
      "INSERT INTO candidates(id,line_id,request_key,version,tag,state,sha,workflow_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        "run-candidate",
        "run-line",
        "request",
        "1.0.0",
        "v1.0.0",
        "building",
        "sha",
        "owner/open/.github/workflows/release.yml@refs/heads/candidate",
        "now",
        "now",
      ],
    );
    const invalidOidc = await api.request(
      "/api/runs/run-candidate/artifacts/file.tar.gz",
      { method: "PUT", headers: { Authorization: "Bearer invalid" } },
    );
    assert.equal(invalidOidc.status, 401);
    assert.deepEqual(await invalidOidc.json(), {
      error: "Invalid workflow identity",
    });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("release PR readiness accepts a freeze-blocked PR only after checks succeed", async () => {
  class FakeGitHub extends GitHub {
    constructor(
      private readonly merge: string,
      private readonly checks: string,
    ) {
      super("test");
    }
    override async request<T>(): Promise<T> {
      return {
        data: {
          repository: {
            pullRequest: {
              headRefOid: "candidate",
              baseRefOid: "base",
              mergeStateStatus: this.merge,
              reviewDecision: "APPROVED",
              state: "OPEN",
              commits: {
                nodes: [
                  { commit: { statusCheckRollup: { state: this.checks } } },
                ],
              },
            },
          },
        },
      } as T;
    }
  }
  await new FakeGitHub("CLEAN", "SUCCESS").assertPullRequestReady(
    "owner/repo",
    1,
    "candidate",
    "base",
  );
  await new FakeGitHub("BLOCKED", "SUCCESS").assertPullRequestReady(
    "owner/repo",
    1,
    "candidate",
    "base",
  );
  await assert.rejects(() =>
    new FakeGitHub("BLOCKED", "PENDING").assertPullRequestReady(
      "owner/repo",
      1,
      "candidate",
      "base",
    ),
  );
  await assert.rejects(() =>
    new FakeGitHub("DIRTY", "SUCCESS").assertPullRequestReady(
      "owner/repo",
      1,
      "candidate",
      "base",
    ),
  );
});

test("seeded projects use unauthenticated GitHub metrics access", async () => {
  const project = { installation_id: 0 } as any;
  const gh = await githubForMetrics(
    { github: { appId: "1", privateKey: "unused" } } as any,
    project,
  );
  assert.equal(gh.token, "");
});

test("a successful retry clears the candidate's previous error", async () => {
  const db = new SQLiteStore(":memory:");
  const dir = await mkdtemp(join(tmpdir(), "envol-retry-"));
  try {
    db.raw.exec(schema);
    await db.run("INSERT INTO projects VALUES(?,?,?,?,?,?)", [
      "p",
      "owner/repo",
      1,
      0,
      "{}",
      "now",
    ]);
    await db.run(
      "INSERT INTO lines(id,project_id,name,branch,channel) VALUES(?,?,?,?,?)",
      ["l", "p", "stable", "main", "stable"],
    );
    const store = new Store(db);
    const line = (await db.all<Line>("SELECT * FROM lines"))[0];
    const candidate = await store.create(line, "1.0.0", "retry");
    await db.run("UPDATE candidates SET error=? WHERE id=?", [
      "old failure",
      candidate.id,
    ]);
    class SuccessfulEngine extends Engine {
      override async prepare() {}
    }
    const engine = new SuccessfulEngine({
      store,
      storage: new LocalStorage(dir),
      credentials: { appId: "unused", privateKey: "unused" },
      url: "https://envol.test",
    });
    assert.equal(await engine.runOne(), true);
    assert.equal((await store.candidate(candidate.id)).error, null);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("metrics collection respects a shared request budget and never stores partial downloads", async () => {
  const db = new SQLiteStore(":memory:");
  const dir = await mkdtemp(join(tmpdir(), "envol-metrics-"));
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  try {
    db.raw.exec(schema);
    for (const [id, repo] of [
      ["a", "owner/first"],
      ["b", "owner/second"],
    ])
      await db.run("INSERT INTO projects VALUES(?,?,?,?,?,?)", [
        id,
        repo,
        0,
        1,
        "{}",
        "now",
      ]);
    globalThis.fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/releases?"))
        return Response.json(
          Array.from({ length: 100 }, () => ({ assets: [] })),
        );
      return Response.json({ stargazers_count: 12 });
    };
    await collectMetrics({
      store: new Store(db),
      storage: new LocalStorage(dir),
      adminToken: "",
      url: "https://envol.test",
    });
    assert.equal(urls.length, 45);
    assert.equal(
      (await db.all("SELECT * FROM metrics WHERE metric='downloads'")).length,
      0,
    );
    assert.equal(
      (await db.all("SELECT * FROM metrics WHERE metric='stars'")).length,
      1,
    );
    assert.equal(
      (await db.all<{ value: string }>("SELECT value FROM runtime_state"))[0]
        .value,
      "a",
    );
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
