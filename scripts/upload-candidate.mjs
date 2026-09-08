import { open, readdir, stat } from "node:fs/promises";
const {
  ENVOL_URL,
  ENVOL_CANDIDATE,
  ACTIONS_ID_TOKEN_REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN,
} = process.env;
if (
  !ENVOL_URL ||
  !ENVOL_CANDIDATE ||
  !ACTIONS_ID_TOKEN_REQUEST_URL ||
  !ACTIONS_ID_TOKEN_REQUEST_TOKEN
)
  throw new Error("Missing Actions/Envol environment");
const origin = new URL(ENVOL_URL);
if (origin.protocol !== "https:") throw new Error("Envol requires HTTPS");
const tokenURL = new URL(ACTIONS_ID_TOKEN_REQUEST_URL);
tokenURL.searchParams.set("audience", ENVOL_URL);
const response = await fetch(tokenURL, {
  headers: { Authorization: `Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
});
if (!response.ok) throw new Error("Could not obtain GitHub OIDC token");
const { value: token } = await response.json();
const filenames = (await readdir("dist-release")).sort();
if (!filenames.length) throw new Error("No candidate artifacts found");
for (const filename of filenames) {
  if (!/^[-\w.]+$/.test(filename))
    throw new Error(`Unsafe artifact filename: ${filename}`);
  const path = `dist-release/${filename}`,
    info = await stat(path);
  if (!info.isFile()) throw new Error(`Artifact is not a file: ${filename}`);
  const file = await open(path);
  try {
    const upload = await fetch(
      `${ENVOL_URL}/api/runs/${encodeURIComponent(ENVOL_CANDIDATE)}/artifacts/${encodeURIComponent(filename)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(info.size),
        },
        body: file.readableWebStream(),
        duplex: "half",
      },
    );
    if (!upload.ok)
      throw new Error(
        `Artifact upload: ${upload.status} ${await upload.text()}`,
      );
  } finally {
    await file.close();
  }
}
const done = await fetch(
  `${ENVOL_URL}/api/runs/${encodeURIComponent(ENVOL_CANDIDATE)}/complete`,
  { method: "POST", headers: { Authorization: `Bearer ${token}` } },
);
if (!done.ok)
  throw new Error(`Candidate completion: ${done.status} ${await done.text()}`);
