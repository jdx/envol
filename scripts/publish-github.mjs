import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

async function github(token, path, method = "GET", body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "envol-publish-workflow",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = new Error(`GitHub ${method} ${path}: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? undefined : response.json();
}

async function remoteDigest(token, repo, asset) {
  if (asset.digest) return asset.digest;
  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases/assets/${asset.id}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/octet-stream",
        "User-Agent": "envol-publish-workflow",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok)
    throw new Error(
      `Could not verify ${asset.name}: GitHub ${response.status} ${await response.text()}`,
    );
  return `sha256:${createHash("sha256")
    .update(new Uint8Array(await response.arrayBuffer()))
    .digest("hex")}`;
}

export async function publishGitHubRelease({ token, repo, tag, directory }) {
  const manifest = JSON.parse(
    await readFile(`${directory}/manifest.json`, "utf8"),
  );
  let release;
  try {
    release = await github(
      token,
      `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    );
  } catch (error) {
    if (error.status !== 404) throw error;
    release = await github(token, `/repos/${repo}/releases`, "POST", {
      tag_name: tag,
      target_commitish: manifest.candidate.sha,
      name: tag,
      draft: true,
      prerelease: manifest.candidate.version.includes("-"),
      body: `Release ${tag}.\n\nSource: ${manifest.candidate.sha}`,
    });
  }
  const files = (await readdir(directory)).filter(
    (name) => name !== "manifest.json",
  );
  for (const name of files) {
    const artifact = manifest.artifacts.find((item) => item.name === name);
    if (!artifact) throw new Error(`Unlisted artifact: ${name}`);
    const existing = release.assets.find((item) => item.name === name);
    if (existing) {
      if (
        (await remoteDigest(token, repo, existing)) !==
        `sha256:${artifact.digest}`
      )
        throw new Error(`Published asset conflicts: ${name}`);
      continue;
    }
    if (!release.draft)
      throw new Error(`Published release is missing expected asset: ${name}`);
    const bytes = await readFile(`${directory}/${name}`);
    const response = await fetch(
      `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.length),
          "User-Agent": "envol-publish-workflow",
        },
        body: bytes,
      },
    );
    if (!response.ok)
      throw new Error(
        `Artifact upload failed: ${name}: GitHub ${response.status} ${await response.text()}`,
      );
    const uploaded = await response.json();
    if (
      (await remoteDigest(token, repo, uploaded)) !==
      `sha256:${artifact.digest}`
    )
      throw new Error(`Uploaded asset digest mismatch: ${name}`);
    release.assets.push(uploaded);
  }
  for (const artifact of manifest.artifacts)
    if (!files.includes(artifact.name))
      throw new Error(`Downloaded artifact missing: ${artifact.name}`);
  if (release.draft)
    release = await github(
      token,
      `/repos/${repo}/releases/${release.id}`,
      "PATCH",
      {
        draft: false,
      },
    );
  return String(release.id);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, ENVOL_TAG, GITHUB_OUTPUT } =
    process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !ENVOL_TAG || !GITHUB_OUTPUT)
    throw new Error("Missing GitHub publication environment");
  const id = await publishGitHubRelease({
    token: GITHUB_TOKEN,
    repo: GITHUB_REPOSITORY,
    tag: ENVOL_TAG,
    directory: "dist-release",
  });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(GITHUB_OUTPUT, `external_id=${id}\n`);
}
