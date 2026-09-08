import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishGitHubRelease } from "../scripts/publish-github.mjs";

test("publication workflow logic accepts matching assets and rejects conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "envol-workflow-"));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(join(directory, "cli.tar.gz"), "retained bytes");
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        candidate: { sha: "candidate-sha", version: "1.0.0" },
        artifacts: [
          {
            name: "cli.tar.gz",
            digest:
              "fb256b25e0c6295ffe7f2d26c984d128075acbf4ac614fbed75887eebe83fc0b",
          },
        ],
      }),
    );
    globalThis.fetch = async () =>
      Response.json({
        id: 7,
        draft: false,
        assets: [
          {
            id: 8,
            name: "cli.tar.gz",
            digest:
              "sha256:fb256b25e0c6295ffe7f2d26c984d128075acbf4ac614fbed75887eebe83fc0b",
          },
        ],
      });
    assert.equal(
      await publishGitHubRelease({
        token: "workflow-token",
        repo: "owner/repo",
        tag: "v1.0.0",
        directory,
      }),
      "7",
    );
    globalThis.fetch = async () =>
      Response.json({
        id: 7,
        draft: false,
        assets: [
          {
            id: 8,
            name: "cli.tar.gz",
            digest: `sha256:${"0".repeat(64)}`,
          },
        ],
      });
    await assert.rejects(
      () =>
        publishGitHubRelease({
          token: "workflow-token",
          repo: "owner/repo",
          tag: "v1.0.0",
          directory,
        }),
      /Published asset conflicts/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication workflow creates a draft, uploads exact assets, then publishes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "envol-workflow-draft-"));
  const originalFetch = globalThis.fetch;
  const requests: { url: string; method: string }[] = [];
  try {
    await writeFile(join(directory, "cli.tar.gz"), "retained bytes");
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        candidate: { sha: "candidate-sha", version: "1.0.0" },
        artifacts: [
          {
            name: "cli.tar.gz",
            digest:
              "fb256b25e0c6295ffe7f2d26c984d128075acbf4ac614fbed75887eebe83fc0b",
          },
        ],
      }),
    );
    globalThis.fetch = async (input, init) => {
      const url = String(input),
        method = init?.method ?? "GET";
      requests.push({ url, method });
      if (method === "GET") return new Response("missing", { status: 404 });
      if (url === "https://api.github.com/repos/owner/repo/releases")
        return Response.json({ id: 7, draft: true, assets: [] });
      if (url.startsWith("https://uploads.github.com/"))
        return Response.json({
          id: 8,
          name: "cli.tar.gz",
          digest:
            "sha256:fb256b25e0c6295ffe7f2d26c984d128075acbf4ac614fbed75887eebe83fc0b",
        });
      return Response.json({ id: 7, draft: false, assets: [] });
    };
    assert.equal(
      await publishGitHubRelease({
        token: "workflow-token",
        repo: "owner/repo",
        tag: "v1.0.0",
        directory,
      }),
      "7",
    );
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET", "POST", "POST", "PATCH"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
