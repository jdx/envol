import { execFileSync } from "node:child_process";
import { readFile, readdir, appendFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

const { CRATES_IO_TOKEN, GITHUB_OUTPUT } = process.env;
if (!CRATES_IO_TOKEN || !GITHUB_OUTPUT)
  throw new Error("No crates.io token available");
const manifest = JSON.parse(
  await readFile("dist-release/manifest.json", "utf8"),
);
const version = manifest.candidate.version;
const packages = (await readdir("dist-release")).filter((name) =>
  name.endsWith(`-${version}.crate`),
);
if (packages.length !== 1)
  throw new Error("Expected exactly one retained crate package");
const filename = packages[0],
  name = filename.slice(0, -`-${version}.crate`.length),
  artifact = manifest.artifacts.find((item) => item.name === filename);
if (!artifact)
  throw new Error("Crate package is absent from the Envol manifest");
const existing = await fetch(
  `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  {
    headers: {
      Accept: "application/json",
      "User-Agent": "envol-publish-workflow",
    },
  },
);
if (existing.ok) {
  const body = await existing.json();
  if (body.version?.checksum !== artifact.digest)
    throw new Error("Existing crates.io version has another digest");
  await appendFile(GITHUB_OUTPUT, `external_id=${name}@${version}\n`);
  process.exit(0);
}
if (existing.status !== 404)
  throw new Error(`crates.io precheck failed: ${existing.status}`);
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--locked", "--no-deps", "--format-version", "1"],
    {
      encoding: "utf8",
    },
  ),
);
const pkg = metadata.packages.find(
  (item) => item.name === name && item.version === version,
);
if (!pkg)
  throw new Error(`Cargo package metadata is missing for ${name}@${version}`);
const root = dirname(pkg.manifest_path);
const readme = pkg.readme ? await readFile(pkg.readme, "utf8") : null;
const upload = {
  name,
  vers: version,
  deps: pkg.dependencies.map((dependency) => ({
    name: dependency.name,
    version_req: dependency.req,
    features: dependency.features,
    optional: dependency.optional,
    default_features: dependency.uses_default_features,
    target: dependency.target,
    kind: dependency.kind ?? "normal",
    registry: dependency.registry,
    explicit_name_in_toml: dependency.rename,
    artifact: dependency.artifact,
    bindep_target: dependency.bindep_target,
    lib: dependency.lib,
  })),
  features: pkg.features,
  authors: pkg.authors,
  description: pkg.description,
  documentation: pkg.documentation,
  homepage: pkg.homepage,
  readme,
  readme_file: pkg.readme ? relative(root, pkg.readme) : null,
  keywords: pkg.keywords,
  categories: pkg.categories,
  license: pkg.license,
  license_file: pkg.license_file ? relative(root, pkg.license_file) : null,
  repository: pkg.repository,
  badges: {},
  links: pkg.links,
  rust_version: pkg.rust_version,
};
const json = Buffer.from(JSON.stringify(upload)),
  crate = await readFile(`dist-release/${filename}`),
  jsonLength = Buffer.alloc(4),
  crateLength = Buffer.alloc(4);
jsonLength.writeUInt32LE(json.length);
crateLength.writeUInt32LE(crate.length);
const response = await fetch("https://crates.io/api/v1/crates/new", {
  method: "PUT",
  headers: {
    Authorization: CRATES_IO_TOKEN,
    Accept: "application/json",
    "Content-Type": "application/octet-stream",
    "Content-Length": String(8 + json.length + crate.length),
    "User-Agent": "envol-publish-workflow",
  },
  body: Buffer.concat([jsonLength, json, crateLength, crate]),
});
if (!response.ok)
  throw new Error(
    `crates.io upload failed: ${response.status} ${await response.text()}`,
  );
await appendFile(GITHUB_OUTPUT, `external_id=${name}@${version}\n`);
