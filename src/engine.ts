import { parse } from "smol-toml";
import { Store, now } from "./store.ts";
import { one } from "./db.ts";
import { GitHub, GitHubError, type GitHubCredentials } from "./github.ts";
import type {
  Artifact,
  Candidate,
  Config,
  Line,
  Project,
  Publisher,
} from "./model.ts";
import type { Storage } from "./storage.ts";
import { createHash } from "node:crypto";
export interface EngineOptions {
  store: Store;
  storage: Storage;
  credentials: GitHubCredentials;
  url: string;
}
const disclosure =
  "*AI-assisted — Tool: Codex; model: unavailable; version: unavailable.*";
class RetryJobError extends Error {}
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
    const storedConfig = JSON.parse(project.config) as Partial<Config>;
    return {
      c,
      line,
      project,
      gh,
      config: Object.assign(
        { publish_workflow: "envol-publish.yml", publishers: ["github"] },
        storedConfig,
      ) as Config,
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
      if (e instanceof RetryJobError) {
        await store.defer(job.id, job.fence);
        return true;
      }
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
          files.push({
            path,
            content: bumpFile(
              path,
              contents,
              c.version,
              project.repo.split("/")[1],
            ),
          });
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
    for (const destination of config.publishers)
      await store.db.run(
        "INSERT INTO publications(candidate_id,destination,state) VALUES(?,?,'pending') ON CONFLICT DO NOTHING",
        [id, destination],
      );
    await store.db.run(
      "UPDATE candidates SET publish_workflow_ref=? WHERE id=?",
      [
        `${project.repo}/.github/workflows/${config.publish_workflow}@refs/tags/${c.tag}`,
        id,
      ],
    );
    c = await store.candidate(id);
    const publishRun = await this.publishRun(c, project, gh, config, fence);
    if (publishRun.status !== "completed")
      throw new RetryJobError("Publication workflow is still running");
    if (publishRun.head_sha !== c.sha || publishRun.conclusion !== "success")
      throw new Error(
        `Publication workflow concluded ${publishRun.conclusion ?? "without success"}`,
      );
    for (const publisher of config.publishers) {
      const externalId = await verifyPublication(
        publisher,
        c,
        project,
        gh,
        artifacts,
      );
      await store.db.run(
        "UPDATE publications SET state='published',external_id=?,error=NULL WHERE candidate_id=? AND destination=?",
        [externalId, id, publisher],
      );
    }
    const unfinished = await one(
      store.db,
      "SELECT destination FROM publications WHERE candidate_id=? AND state<>'published'",
      [id],
    );
    if (unfinished) throw new Error("Publication verification is incomplete");
    await store.transition(await store.candidate(id), "released");
  }
  private async publishRun(
    c: Candidate,
    project: Project,
    gh: GitHub,
    config: Config,
    fence: () => Promise<void>,
  ) {
    type Run = {
      id: number;
      status: string;
      conclusion: string | null;
      head_sha: string;
      event: string;
      path: string;
    };
    const expectedPath = `.github/workflows/${config.publish_workflow}`;
    let dispatchAt = c.publish_dispatch_at;
    if (c.publish_run_id) {
      const run = await gh.request<Run>(
        `/repos/${project.repo}/actions/runs/${c.publish_run_id}`,
      );
      if (run.head_sha !== c.sha || run.path !== expectedPath)
        throw new Error("Publication workflow run does not match candidate");
      if (run.status !== "completed" || run.conclusion === "success")
        return run;
      await this.options.store.db.run(
        "UPDATE candidates SET publish_run_id=NULL,publish_dispatch_at=NULL WHERE id=? AND publish_run_id=?",
        [c.id, c.publish_run_id],
      );
      dispatchAt = null;
    }
    const runs = await gh.request<{ workflow_runs: Run[] }>(
      `/repos/${project.repo}/actions/workflows/${config.publish_workflow}/runs?branch=${encodeURIComponent(c.tag)}&event=workflow_dispatch&per_page=100`,
    );
    const reconciled = runs.workflow_runs.find(
      (run) =>
        run.head_sha === c.sha &&
        run.path === expectedPath &&
        (run.status !== "completed" || run.conclusion === "success"),
    );
    if (reconciled) {
      await this.options.store.db.run(
        "UPDATE candidates SET publish_run_id=? WHERE id=?",
        [String(reconciled.id), c.id],
      );
      return reconciled;
    }
    if (dispatchAt && Date.now() - Date.parse(dispatchAt) < 2 * 60 * 1000)
      throw new RetryJobError(
        "Waiting for publication workflow reconciliation",
      );
    const dispatches = await one<{ count: number }>(
      this.options.store.db,
      "SELECT COUNT(*) AS count FROM events WHERE candidate_id=? AND kind='publish_dispatch'",
      [c.id],
    );
    if ((dispatches?.count ?? 0) >= 3)
      throw new Error(
        "Publication workflow could not be reconciled after 3 dispatch attempts",
      );
    await fence();
    await this.options.store.db.run(
      "UPDATE candidates SET publish_dispatch_at=? WHERE id=?",
      [now(), c.id],
    );
    await this.options.store.event(
      c.id,
      "publish_dispatch",
      `Dispatching ${config.publish_workflow} for ${c.tag}`,
    );
    await gh.request(
      `/repos/${project.repo}/actions/workflows/${config.publish_workflow}/dispatches`,
      "POST",
      {
        ref: c.tag,
        inputs: {
          candidate_id: c.id,
          tag: c.tag,
          envol_url: this.options.url,
        },
      },
    );
    throw new RetryJobError("Publication workflow dispatched");
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
    ].slice(0, 12);
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
export async function verifyPublication(
  publisher: Publisher,
  candidate: Candidate,
  project: Project,
  gh: GitHub,
  artifacts: Artifact[],
  fetcher: typeof fetch = fetch,
) {
  if (publisher === "github")
    return verifyGitHubPublication(gh, project.repo, candidate.tag, artifacts);
  return verifyCratesPublication(candidate.version, artifacts, fetcher);
}

export async function verifyGitHubPublication(
  gh: GitHub,
  repo: string,
  tag: string,
  artifacts: Artifact[],
) {
  const release = await gh.optional<{
    id: number;
    draft: boolean;
    assets: { id: number; name: string; digest: string | null }[];
  }>(`/repos/${repo}/releases/tags/${tag}`);
  if (!release || release.draft)
    throw new Error("GitHub release is missing or still a draft");
  for (const artifact of artifacts) {
    const asset = release.assets.find((item) => item.name === artifact.name);
    if (!asset)
      throw new Error(`GitHub release is missing asset ${artifact.name}`);
    const digest =
      asset.digest ??
      `sha256:${createHash("sha256")
        .update(await gh.releaseAsset(repo, asset.id))
        .digest("hex")}`;
    if (digest !== `sha256:${artifact.digest}`)
      throw new Error(`GitHub release asset digest mismatch: ${artifact.name}`);
  }
  return String(release.id);
}

export async function verifyCratesPublication(
  version: string,
  artifacts: Artifact[],
  fetcher: typeof fetch = fetch,
) {
  const suffix = `-${version}.crate`;
  const packages = artifacts.filter((artifact) =>
    artifact.name.endsWith(suffix),
  );
  if (packages.length !== 1)
    throw new Error("Expected exactly one retained crate package");
  const artifact = packages[0];
  const crate = artifact.name.slice(0, -suffix.length);
  const response = await fetcher(
    `https://crates.io/api/v1/crates/${encodeURIComponent(crate)}/${encodeURIComponent(version)}`,
    { headers: { Accept: "application/json", "User-Agent": "envol" } },
  );
  if (!response.ok)
    throw new Error(`crates.io version is missing: ${crate}@${version}`);
  const body = (await response.json()) as { version?: { checksum?: string } };
  if (body.version?.checksum !== artifact.digest)
    throw new Error(`crates.io package digest mismatch: ${artifact.name}`);
  return `${crate}@${version}`;
}

export function bumpFile(
  path: string,
  contents: string,
  version: string,
  packageName?: string,
) {
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
  if (path.endsWith("Cargo.lock")) {
    if (!packageName) throw new Error("Cargo.lock requires a package name");
    return replaceCargoLockVersion(contents, packageName, version);
  }
  if (path.endsWith("package.json")) {
    const doc = JSON.parse(contents);
    doc.version = version;
    return JSON.stringify(doc, null, 2) + "\n";
  }
  if (path.endsWith("package-lock.json")) {
    const doc = JSON.parse(contents);
    doc.version = version;
    if (doc.packages?.[""]) doc.packages[""].version = version;
    return JSON.stringify(doc, null, 2) + "\n";
  }
  throw new Error(`Unsupported version file: ${path}`);
}

function replaceCargoLockVersion(
  contents: string,
  packageName: string,
  version: string,
) {
  const blocks = contents.split(/(?=\[\[package\]\])/);
  const index = blocks.findIndex((block) => {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    return name === packageName;
  });
  if (index < 0) throw new Error(`No ${packageName} package in Cargo.lock`);
  if (!/^version = "[^"]+"$/m.test(blocks[index]))
    throw new Error(`No ${packageName} version in Cargo.lock`);
  blocks[index] = blocks[index].replace(
    /^version = "[^"]+"$/m,
    `version = "${version}"`,
  );
  return blocks.join("");
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
