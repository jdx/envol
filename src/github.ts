import { importPKCS8, SignJWT } from "jose";
export interface GitHubCredentials {
  appId: string;
  privateKey: string;
}
const installationTokens = new Map<
  string,
  { token: string; expiresAt: number }
>();
export class GitHub {
  constructor(readonly token: string) {}
  static async installation(credentials: GitHubCredentials, id: number) {
    const cacheKey = `${credentials.appId}:${id}`;
    const cached = installationTokens.get(cacheKey);
    if (cached && cached.expiresAt - 5 * 60 * 1000 > Date.now())
      return new GitHub(cached.token);
    const key = await importPKCS8(
      credentials.privateKey.replace(/\\n/g, "\n"),
      "RS256",
    );
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(credentials.appId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
      .setExpirationTime("9m")
      .sign(key);
    const app = new GitHub(jwt);
    const result = await app.request<{ token: string; expires_at: string }>(
      `/app/installations/${id}/access_tokens`,
      "POST",
    );
    installationTokens.set(cacheKey, {
      token: result.token,
      expiresAt: Date.parse(result.expires_at),
    });
    return new GitHub(result.token);
  }
  async request<T = Record<string, unknown>>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    if (!path.startsWith("/")) throw new Error("Invalid GitHub API path");
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        Accept: "application/vnd.github+json",
        "User-Agent": "envol",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok)
      throw new GitHubError(
        response.status,
        `${method} ${path}: GitHub ${response.status}`,
      );
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }
  async optional<T>(path: string) {
    try {
      return await this.request<T>(path);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }
  async releaseAsset(
    repo: string,
    id: number,
  ): Promise<Uint8Array<ArrayBufferLike>> {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases/assets/${id}`,
      {
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          Accept: "application/octet-stream",
          "User-Agent": "envol",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok)
      throw new GitHubError(
        response.status,
        `GET release asset ${id}: GitHub ${response.status}`,
      );
    return new Uint8Array(await response.arrayBuffer());
  }
  async head(repo: string, branch: string) {
    return (
      await this.request<{ object: { sha: string } }>(
        `/repos/${repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
      )
    ).object.sha;
  }
  async freeze(
    repo: string,
    branch: string,
    appId: number,
    rulesetId: number | null,
    active: boolean,
  ) {
    const body = {
      name: `envol-release-freeze-${branch}`,
      target: "branch",
      enforcement: active ? "active" : "disabled",
      bypass_actors: [
        { actor_id: appId, actor_type: "Integration", bypass_mode: "always" },
      ],
      conditions: {
        ref_name: { include: [`refs/heads/${branch}`], exclude: [] },
      },
      rules: [{ type: "update" }, { type: "deletion" }],
    };
    if (rulesetId) {
      await this.request(`/repos/${repo}/rulesets/${rulesetId}`, "PUT", body);
      return rulesetId;
    }
    return (
      await this.request<{ id: number }>(
        `/repos/${repo}/rulesets`,
        "POST",
        body,
      )
    ).id;
  }
  async verifyFreeze(repo: string, branch: string, id: number) {
    const rule = await this.request<{
      enforcement: string;
      conditions: { ref_name: { include: string[] } };
      rules: { type: string }[];
    }>(`/repos/${repo}/rulesets/${id}`);
    if (
      rule.enforcement !== "active" ||
      !rule.conditions.ref_name.include.includes(`refs/heads/${branch}`) ||
      !rule.rules.some((r) => r.type === "update")
    )
      throw new Error("Release freeze is not active");
  }
  async file(repo: string, path: string, ref: string) {
    const file = await this.request<{ content: string; encoding: string }>(
      `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
    );
    if (file.encoding !== "base64")
      throw new Error("Unsupported file encoding");
    return new TextDecoder().decode(
      Uint8Array.from(atob(file.content.replace(/\s/g, "")), (c) =>
        c.charCodeAt(0),
      ),
    );
  }
  async candidateCommit(
    repo: string,
    base: string,
    files: { path: string; content: string }[],
    message: string,
  ) {
    const parent = await this.request<{ tree: { sha: string } }>(
      `/repos/${repo}/git/commits/${base}`,
    );
    const tree = await this.request<{ sha: string }>(
      `/repos/${repo}/git/trees`,
      "POST",
      {
        base_tree: parent.tree.sha,
        tree: files.map((f) => ({ ...f, mode: "100644", type: "blob" })),
      },
    );
    return (
      await this.request<{ sha: string }>(
        `/repos/${repo}/git/commits`,
        "POST",
        { message, tree: tree.sha, parents: [base] },
      )
    ).sha;
  }
  async ensureTag(repo: string, tag: string, sha: string) {
    const path = `/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`;
    const existing = await this.optional<{
      object: { sha: string; type: string };
    }>(path);
    if (existing) {
      const target =
        existing.object.type === "tag"
          ? (
              await this.request<{ object: { sha: string } }>(
                `/repos/${repo}/git/tags/${existing.object.sha}`,
              )
            ).object.sha
          : existing.object.sha;
      if (target !== sha)
        throw new Error("Release tag already points to another commit");
      return;
    }
    const object = await this.request<{ sha: string }>(
      `/repos/${repo}/git/tags`,
      "POST",
      { tag, message: `Release ${tag}`, object: sha, type: "commit" },
    );
    await this.request(`/repos/${repo}/git/refs`, "POST", {
      ref: `refs/tags/${tag}`,
      sha: object.sha,
    });
  }
  async assertPullRequestReady(
    repo: string,
    number: number,
    sha: string,
    base: string,
  ) {
    const [owner, name] = repo.split("/");
    const result = await this.request<{
      errors?: unknown[];
      data?: {
        repository: {
          pullRequest: {
            headRefOid: string;
            baseRefOid: string;
            mergeStateStatus: string;
            reviewDecision: string | null;
            state: string;
            commits: {
              nodes: {
                commit: { statusCheckRollup: { state: string } | null };
              }[];
            };
          };
        };
      };
    }>("/graphql", "POST", {
      query:
        "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid mergeStateStatus reviewDecision state commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}",
      variables: { owner, name, number },
    });
    const pr = result.data?.repository.pullRequest;
    const checks = pr?.commits.nodes[0]?.commit.statusCheckRollup?.state;
    if (
      result.errors ||
      !pr ||
      pr.headRefOid !== sha ||
      pr.baseRefOid !== base ||
      pr.state !== "OPEN" ||
      !["CLEAN", "BLOCKED"].includes(pr.mergeStateStatus) ||
      checks !== "SUCCESS" ||
      pr.reviewDecision === "CHANGES_REQUESTED" ||
      pr.reviewDecision === "REVIEW_REQUIRED"
    )
      throw new Error(
        "Release PR checks/reviews are not ready, or its commits changed",
      );
  }
}
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
