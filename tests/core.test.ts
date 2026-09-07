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
import { bumpFile } from "../src/engine.ts";
import { app } from "../src/app.ts";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const schema = await readFile(
  new URL("../migrations/0001_initial.sql", import.meta.url),
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
  await store.finish(job.id, job.fence - 1);
  assert.equal(
    (await db.all<{ state: string }>("SELECT state FROM jobs"))[0].state,
    "running",
  );
  await store.finish(job.id, job.fence);
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
test("version policy prevents stable prereleases and wrong channels", () => {
  assert.equal(releaseVersion("1.2.3", "stable"), "1.2.3");
  assert.equal(releaseVersion("2.0.0-rc.1", "rc"), "2.0.0-rc.1");
  for (const v of ["latest", "v1.2.3", "1.2", "1.2.3+build", "2.0.0-alpha.1"])
    assert.throws(() => releaseVersion(v, "stable"));
  assert.throws(() => releaseVersion("2.0.0-alpha.1", "beta"));
  assert.equal(nextVersion("1.2.3", "major", "alpha"), "2.0.0-alpha.1");
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
  assert.match(
    bumpFile("Cargo.toml", '[workspace.package]\nversion="0.1.0"', "2.0.0"),
    /2.0.0/,
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
    assert.equal(
      (await api.request("/api/admin/candidates/x/artifacts/y")).status,
      401,
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
