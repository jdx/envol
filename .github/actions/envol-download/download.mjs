import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const {
  ENVOL_URL,
  ENVOL_CANDIDATE,
  ENVOL_DOWNLOAD,
  ACTIONS_ID_TOKEN_REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  GITHUB_OUTPUT,
} = process.env;
if (
  !ENVOL_URL ||
  !ENVOL_CANDIDATE ||
  !ACTIONS_ID_TOKEN_REQUEST_URL ||
  !ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
  !GITHUB_OUTPUT
)
  throw new Error("Missing Actions/Envol environment");
const origin = new URL(ENVOL_URL);
if (origin.protocol !== "https:") throw new Error("Envol requires HTTPS");
const tokenURL = new URL(ACTIONS_ID_TOKEN_REQUEST_URL);
tokenURL.searchParams.set("audience", ENVOL_URL);
const tokenResponse = await fetch(tokenURL, {
  headers: { Authorization: `Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
});
if (!tokenResponse.ok) throw new Error("Could not obtain GitHub OIDC token");
const { value: token } = await tokenResponse.json();
const headers = { Authorization: `Bearer ${token}` };
const manifestResponse = await fetch(
  `${ENVOL_URL.replace(/\/$/, "")}/api/publish/${encodeURIComponent(ENVOL_CANDIDATE)}/manifest`,
  { headers },
);
if (!manifestResponse.ok)
  throw new Error(
    `Manifest download: ${manifestResponse.status} ${await manifestResponse.text()}`,
  );
const manifest = await manifestResponse.json();
if (!Array.isArray(manifest.publishers) || !Array.isArray(manifest.artifacts))
  throw new Error("Invalid Envol manifest");
await appendFile(
  GITHUB_OUTPUT,
  `publishers=${JSON.stringify(manifest.publishers)}\nversion=${manifest.candidate.version}\n`,
);
if (ENVOL_DOWNLOAD === "false") process.exit(0);
await rm("dist-release", { recursive: true, force: true });
await mkdir("dist-release", { recursive: true });
for (const artifact of manifest.artifacts) {
  if (
    typeof artifact.name !== "string" ||
    !/^[-\w.]+$/.test(artifact.name) ||
    typeof artifact.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 0
  )
    throw new Error("Invalid artifact manifest entry");
  const downloadURL = new URL(artifact.download_url);
  if (downloadURL.origin !== origin.origin)
    throw new Error("Artifact URL uses another origin");
  const response = await fetch(downloadURL, { headers });
  if (!response.ok || !response.body)
    throw new Error(`Artifact download failed: ${artifact.name}`);
  const path = `dist-release/${artifact.name}`;
  const hash = createHash("sha256");
  const stream = Readable.fromWeb(response.body);
  stream.on("data", (chunk) => hash.update(chunk));
  await pipeline(stream, createWriteStream(path, { flags: "wx" }));
  const size = (await stat(path)).size;
  if (size !== artifact.size || hash.digest("hex") !== artifact.digest)
    throw new Error(`Artifact integrity failure: ${artifact.name}`);
}
await writeFile("dist-release/manifest.json", JSON.stringify(manifest));
