import { parse } from "smol-toml";
import { Store, now } from "./store.ts";
import { one } from "./db.ts";
import { GitHub, GitHubError, type GitHubCredentials } from "./github.ts";
import type { Artifact, Candidate, Config, Line, Project } from "./model.ts";
import type { Storage } from "./storage.ts";
import { createHash } from "node:crypto";
export interface EngineOptions {
  store: Store;
  storage: Storage;
  credentials: GitHubCredentials;
  url: string;
}
const disclosure =
  "*AI-assisted — Tool: Codex; model: OpenAI/GPT-6; version: unavailable.*";
export class Engine {
  constructor(readonly options: EngineOptions) {}
  async context(id: string) {
    const c = await this.options.store.candidate(id),
      db = this.options.store.db;
    const line = await one<Line>(db, "SELECT * FROM lines WHERE id=?", [
      c.line_id,
    ]);
    if (!line) throw new Error("Release line missing");
    const project = await one<Project>(
      db,
      "SELECT * FROM projects WHERE id=?",
      [line.project_id],
    );
    if (!project) throw new Error("Project missing");
    const gh = await GitHub.installation(
      this.options.credentials,
      project.installation_id,
    );
    return {
      c,
      line,
      project,
      gh,
      config: JSON.parse(project.config) as Config,
    };
  }
  async runOne() {
    const store = this.options.store,
      job = await store.claim();
    if (!job) return false;
    const fence = async () => {
      const current = await one<{
        fence: number;
        state: string;
        lease_until: number;
      }>(store.db, "SELECT fence,state,lease_until FROM jobs WHERE id=?", [
        job.id,
      ]);
      if (
        !current ||
        current.fence !== job.fence ||
        current.state !== "running" ||
        current.lease_until < Date.now()
      )
        throw new Error("Job lease lost");
      const candidate = await store.candidate(job.candidate_id);
      if (
        job.kind !== "cancel" &&
        ["cancelling", "cancelled"].includes(candidate.state)
      )
        throw new Error("Candidate was cancelled");
      await store.db.run(
        "UPDATE jobs SET lease_until=? WHERE id=? AND fence=?",
        [Date.now() + 240000, job.id, job.fence],
      );
    };
    try {
      await fence();
      if (job.kind === "prepare") await this.prepare(job.candidate_id, fence);
      else if (job.kind === "promote")
        await this.promote(job.candidate_id, fence);
      else if (job.kind === "cancel")
        await this.cancel(job.candidate_id, fence);
      else throw new Error("Unknown job");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (await store.finish(job.id, job.fence, message)) {
        await store.db.run(
          "UPDATE candidates SET error=?,updated_at=? WHERE id=?",
          [message, now(), job.candidate_id],
        );
        await store.event(job.candidate_id, "error", message);
      }
      return true;
    }
    await store.succeed(job.id, job.candidate_id, job.fence);
    return true;
  }
  async prepare(id: string, fence: () => Promise<void>) {
    const { line, project, gh, config } = await this.context(id),
      store = this.options.store;
    let c = await store.candidate(id);
    if (c.state === "queued") c = await store.transition(c, "preparing");
    if (c.state !== "preparing") return;
    // Persist the disabled ruleset ID before activation so recovery can always find it.
    let ruleset = line.ruleset_id;
    if (!ruleset) {
      ruleset = await gh.freeze(
        project.repo,
        line.branch,
        Number(this.options.credentials.appId),
        null,
        false,
      );
      await store.db.run("UPDATE lines SET ruleset_id=? WHERE id=?", [
        ruleset,
        line.id,
      ]);
    }
    await fence();
    await gh.freeze(
      project.repo,
      line.branch,
      Number(this.options.credentials.appId),
      ruleset,
      true,
    );
    await store.db.run("UPDATE candidates SET frozen=1 WHERE id=?", [id]);
    await gh.verifyFreeze(project.repo, line.branch, ruleset);
    const base = await gh.head(project.repo, line.branch);
    if (c.base_sha && c.base_sha !== base)
      throw new Error("Source branch changed after candidate preparation");
    await store.db.run("UPDATE candidates SET base_sha=? WHERE id=?", [
      base,
      id,
    ]);
    const branch = `envol/candidate/${id}`;
    let sha = c.sha;
    if (!sha) {
      const existing = await gh.optional<{ object: { sha: string } }>(
        `/repos/${project.repo}/git/ref/heads/${branch}`,
      );
      if (existing) sha = existing.object.sha;
      else {
        const files = [];
        for (const path of config.version_files) {
          const contents = await gh.file(project.repo, path, base);
          files.push({ path, content: bumpFile(path, contents, c.version) });
        }
        let prior = "";
        try {
          prior = await gh.file(project.repo, "CHANGELOG.md", base);
        } catch (error) {
          if (!(error instanceof GitHubError && error.status === 404))
            throw error;
        }
        files.push({
          path: "CHANGELOG.md",
          content: `# ${c.version}\n\nRelease prepared from ${base}.\n\n${prior}`,
        });
        sha = await gh.candidateCommit(
          project.repo,
          base,
          files,
          `chore: release ${c.version}`,
        );
        await fence();
        await gh.request(`/repos/${project.repo}/git/refs`, "POST", {
          ref: `refs/heads/${branch}`,
          sha,
        });
      }
      await store.db.run("UPDATE candidates SET sha=? WHERE id=?", [sha, id]);
    }
    if (!c.pr) {
      const prs = await gh.request<{ number: number }[]>(
        `/repos/${project.repo}/pulls?head=${encodeURIComponent(project.repo.split("/")[0] + ":" + branch)}&base=${encodeURIComponent(line.branch)}&state=open`,
      );
      const pr =
        prs[0] ??
        (await gh.request<{ number: number }>(
          `/repos/${project.repo}/pulls`,
          "POST",
          {
            title: `chore: release ${c.version}`,
            head: branch,
            base: line.branch,
            draft: false,
            body: `Prepare ${c.tag} from frozen source ${base}.\n\nEnvol will validate and retain artifacts before advancing the source branch and tagging this exact candidate.\n\n[Candidate dashboard](${this.options.url}/?candidate=${id})\n\n${disclosure}`,
          },
        ));
      await store.db.run("UPDATE candidates SET pr=? WHERE id=?", [
        pr.number,
        id,
      ]);
    }
    await store.db.run("UPDATE candidates SET workflow_ref=? WHERE id=?", [
      `${project.repo}/.github/workflows/${config.workflow}@refs/heads/${branch}`,
      id,
    ]);
    // Reconcile a possibly successful dispatch before retrying it.
    const runs = await gh.request<{
      workflow_runs: { id: number; head_sha: string }[];
    }>(
      `/repos/${project.repo}/actions/workflows/${config.workflow}/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&per_page=100`,
    );
    const dispatched = runs.workflow_runs.find((run) => run.head_sha === sha);
    if (dispatched)
      await store.db.run("UPDATE candidates SET run_id=? WHERE id=?", [
        String(dispatched.id),
        id,
      ]);
    else {
      await fence();
      await gh.request(
        `/repos/${project.repo}/actions/workflows/${config.workflow}/dispatches`,
        "POST",
        {
          ref: branch,
          inputs: { candidate_id: id, envol_url: this.options.url },
        },
      );
    }
    await store.transition(await store.candidate(id), "building");
  }
  async promote(id: string, fence: () => Promise<void>) {
    const { line, project, gh, config } = await this.context(id),
      store = this.options.store;
    let c = await store.candidate(id);
    if (c.state === "ready") c = await store.transition(c, "promoting");
    if (!["promoting", "publishing"].includes(c.state)) return;
    if (!c.sha || !c.base_sha || !line.ruleset_id || !c.run_id)
      throw new Error("Candidate is incomplete");
    const run = await gh.request<{ conclusion: string; head_sha: string }>(
      `/repos/${project.repo}/actions/runs/${c.run_id}`,
    );
    if (run.head_sha !== c.sha || run.conclusion !== "success")
      throw new Error("Candidate workflow has not succeeded");
    const artifacts = await store.db.all<Artifact>(
      "SELECT * FROM artifacts WHERE candidate_id=?",
      [id],
    );
    if (
      config.required_artifacts.some(
        (name) => !artifacts.some((a) => a.name === name),
      )
    )
      throw new Error("Required artifacts missing");
    for (const artifact of artifacts) {
      const stored = await this.options.storage.get(artifact.storage_key);
      if (!stored) throw new Error(`Missing artifact ${artifact.name}`);
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of stored.body) {
        hash.update(chunk);
        size += chunk.length;
      }
      if (hash.digest("hex") !== artifact.digest || size !== artifact.size)
        throw new Error(`Artifact integrity failure: ${artifact.name}`);
    }
    if (c.state === "promoting") {
      await fence();
      await gh.verifyFreeze(project.repo, line.branch, line.ruleset_id);
      const head = await gh.head(project.repo, line.branch);
      if (head !== c.base_sha && head !== c.sha)
        throw new Error("Source branch changed; refusing promotion");
      if (head !== c.sha) {
        if (!c.pr) throw new Error("Release PR missing");
        await gh.assertPullRequestReady(project.repo, c.pr, c.sha, c.base_sha);
        await fence();
        await gh.request(
          `/repos/${project.repo}/git/refs/heads/${line.branch}`,
          "PATCH",
          { sha: c.sha, force: false },
        );
      }
      await fence();
      await gh.ensureTag(project.repo, c.tag, c.sha);
      await gh.freeze(
        project.repo,
        line.branch,
        Number(this.options.credentials.appId),
        line.ruleset_id,
        false,
      );
      await store.db.run("UPDATE candidates SET frozen=0 WHERE id=?", [id]);
      c = await store.transition(await store.candidate(id), "publishing");
    }
    await fence();
    await this.publishGitHub(c, project, gh, artifacts, fence);
    await store.transition(await store.candidate(id), "released");
  }
  async publishGitHub(
    c: Candidate,
    project: Project,
    gh: GitHub,
    artifacts: Artifact[],
    fence: () => Promise<void>,
  ) {
    const db = this.options.store.db;
    await db.run(
      "INSERT INTO publications(candidate_id,destination,state) VALUES(?,'github','pending') ON CONFLICT DO NOTHING",
      [c.id],
    );
    type Release = {
      id: number;
      draft: boolean;
      assets: { id: number; name: string; digest: string | null }[];
    };
    let release = await gh.optional<Release>(
      `/repos/${project.repo}/releases/tags/${c.tag}`,
    );
    if (!release) {
      await fence();
      release = await gh.request<Release>(
        `/repos/${project.repo}/releases`,
        "POST",
        {
          tag_name: c.tag,
          target_commitish: c.sha,
          name: c.tag,
          draft: true,
          prerelease: c.version.includes("-"),
          body: `Release ${c.tag}.\n\nSource: ${c.sha}\n\n${disclosure}`,
        },
      );
    }
    const uploaded = new Set<string>();
    for (const a of artifacts) {
      const existing = release.assets.find((x) => x.name === a.name);
      if (existing) {
        const digest = existing.digest
          ? existing.digest
          : `sha256:${await this.downloadAssetDigest(gh, project.repo, existing.id)}`;
        if (digest !== `sha256:${a.digest}`)
          throw new Error(`Published asset conflicts: ${a.name}`);
        continue;
      }
      if (!release.draft)
        throw new Error(
          "Published release is missing expected assets; manual recovery required",
        );
      const stored = await this.options.storage.get(a.storage_key);
      if (!stored) throw new Error("Artifact missing");
      await fence();
      const response = await fetch(
        `https://uploads.github.com/repos/${project.repo}/releases/${release.id}/assets?name=${encodeURIComponent(a.name)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${gh.token}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(a.size),
            "User-Agent": "envol",
          },
          body: stored.body,
          duplex: "half",
        } as RequestInit,
      );
      if (!response.ok)
        throw new Error(`Artifact upload failed: ${response.status}`);
      uploaded.add(a.name);
    }
    const final = await gh.request<Release>(
      `/repos/${project.repo}/releases/${release.id}`,
    );
    for (const artifact of artifacts) {
      const asset = final.assets.find((item) => item.name === artifact.name);
      if (!asset) throw new Error("Remote asset inventory verification failed");
      if (asset.digest === `sha256:${artifact.digest}`) continue;
      // A successful response verifies this invocation's byte stream was accepted. On a
      // later retry, where that fact is unavailable, hash GitHub's stored object instead.
      if (uploaded.has(artifact.name)) continue;
      if (
        asset.digest ||
        (await this.downloadAssetDigest(gh, project.repo, asset.id)) !==
          artifact.digest
      )
        throw new Error("Remote asset inventory verification failed");
    }
    if (final.draft) {
      await fence();
      await gh.request(
        `/repos/${project.repo}/releases/${release.id}`,
        "PATCH",
        { draft: false },
      );
    }
    await db.run(
      "UPDATE publications SET state='published',external_id=?,error=NULL WHERE candidate_id=? AND destination='github'",
      [String(release.id), c.id],
    );
  }
  private async downloadAssetDigest(gh: GitHub, repo: string, id: number) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases/assets/${id}`,
      {
        headers: {
          Authorization: `Bearer ${gh.token}`,
          Accept: "application/octet-stream",
          "User-Agent": "envol",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok || !response.body)
      throw new Error(
        `Artifact verification download failed: ${response.status}`,
      );
    const hash = createHash("sha256");
    for await (const chunk of response.body) hash.update(chunk);
    return hash.digest("hex");
  }
  async cancel(id: string, fence: () => Promise<void>) {
    const { c, line, project, gh } = await this.context(id),
      store = this.options.store;
    if (c.state !== "cancelling")
      throw new Error("Candidate is not cancelling");
    if (c.run_id) {
      await gh
        .request(
          `/repos/${project.repo}/actions/runs/${c.run_id}/cancel`,
          "POST",
        )
        .catch(() => {});
      const run = await gh.request<{ status: string }>(
        `/repos/${project.repo}/actions/runs/${c.run_id}`,
      );
      if (run.status !== "completed")
        throw new Error(
          "Workflow cancellation pending; retry cancellation once stopped",
        );
    }
    if (c.sha && (await gh.head(project.repo, line.branch)) === c.sha)
      throw new Error(
        "Candidate reached source branch; recover promotion instead of cancellation",
      );
    await fence();
    if (line.ruleset_id)
      await gh.freeze(
        project.repo,
        line.branch,
        Number(this.options.credentials.appId),
        line.ruleset_id,
        false,
      );
    await store.db.run("UPDATE candidates SET frozen=0 WHERE id=?", [id]);
    await store.transition(await store.candidate(id), "cancelled");
  }
  async reconcileBuilds() {
    const store = this.options.store;
    const candidates = await store.db.all<Candidate>(
      "SELECT * FROM candidates WHERE state='building' ORDER BY id",
    );
    const cursor = await one<{ value: string }>(
      store.db,
      "SELECT value FROM runtime_state WHERE key='reconcile_cursor'",
    );
    const start = cursor
      ? Math.max(
          0,
          candidates.findIndex((candidate) => candidate.id > cursor.value),
        )
      : 0;
    const page = [
      ...candidates.slice(start),
      ...candidates.slice(0, start),
    ].slice(0, 100);
    for (const candidate of page) {
      try {
        const { project, config, gh } = await this.context(candidate.id);
        let runId = candidate.run_id;
        if (!runId) {
          const runs = await gh.request<{
            workflow_runs: { id: number; head_sha: string }[];
          }>(
            `/repos/${project.repo}/actions/workflows/${config.workflow}/runs?branch=${encodeURIComponent(`envol/candidate/${candidate.id}`)}&event=workflow_dispatch&per_page=100`,
          );
          const run = runs.workflow_runs.find(
            (r) => r.head_sha === candidate.sha,
          );
          if (!run) continue;
          runId = String(run.id);
          await store.db.run(
            "UPDATE candidates SET run_id=? WHERE id=? AND run_id IS NULL",
            [runId, candidate.id],
          );
        }
        const run = await gh.request<{
          status: string;
          conclusion: string;
          head_sha: string;
        }>(`/repos/${project.repo}/actions/runs/${runId}`);
        if (run.status !== "completed") continue;
        if (run.head_sha !== candidate.sha)
          throw new Error("Workflow SHA mismatch");
        const artifacts = await store.db.all<Artifact>(
          "SELECT * FROM artifacts WHERE candidate_id=?",
          [candidate.id],
        );
        const completed = await one(
          store.db,
          "SELECT id FROM events WHERE candidate_id=? AND kind='build-complete'",
          [candidate.id],
        );
        if (
          run.conclusion === "success" &&
          completed &&
          config.required_artifacts.every((name) =>
            artifacts.some((a) => a.name === name),
          )
        ) {
          const ready = await store.transition(
            await store.candidate(candidate.id),
            "ready",
          );
          if (config.auto_promote) await store.enqueue(ready.id, "promote");
        } else {
          await store.event(
            candidate.id,
            "validation-failed",
            `Workflow concluded ${run.conclusion}; cancelling unpublished candidate`,
          );
          await store.transition(
            await store.candidate(candidate.id),
            "cancelling",
          );
          await store.enqueue(candidate.id, "cancel");
        }
      } catch (error) {
        await store.event(
          candidate.id,
          "reconcile-error",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        await store.db.run(
          "INSERT INTO runtime_state VALUES('reconcile_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [candidate.id],
        );
      }
    }
  }
}
export function bumpFile(path: string, contents: string, version: string) {
  if (path.endsWith("Cargo.toml")) {
    const doc = parse(contents) as Record<string, any>;
    const section =
      typeof doc.package?.version === "string"
        ? "package"
        : typeof doc.workspace?.package?.version === "string"
          ? "workspace.package"
          : null;
    if (!section) throw new Error(`No literal version in ${path}`);
    return replaceTomlVersion(contents, section, version, path);
  }
  if (path.endsWith("package.json")) {
    const doc = JSON.parse(contents);
    doc.version = version;
    return JSON.stringify(doc, null, 2) + "\n";
  }
  throw new Error(`Unsupported version file: ${path}`);
}

function replaceTomlVersion(
  contents: string,
  section: string,
  version: string,
  path: string,
) {
  const lines = contents.split(/(?<=\n)/);
  let active = false;
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index].match(
      /^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?(?:\r?\n)?$/,
    );
    if (header) {
      active = header[1].replace(/\s/g, "") === section;
      continue;
    }
    if (!active) continue;
    const match = lines[index].match(
      /^(\s*version\s*=\s*)(["'])([^"']*)(\2)([^\r\n]*)(\r?\n)?$/,
    );
    if (!match) continue;
    lines[index] =
      `${match[1]}${match[2]}${version}${match[4]}${match[5]}${match[6] ?? ""}`;
    return lines.join("");
  }
  throw new Error(`No literal version in ${path}`);
}
