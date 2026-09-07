// Executed only by GitHub Actions. No local Cloudflare login is required.
import { readFile, writeFile } from "node:fs/promises";
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token)
  throw new Error("Configure CLOUDFLARE_API_TOKEN in GitHub Actions secrets");
const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
const account = config.account_id;
async function api(path, method = "GET", body) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const json = await response.json();
  if (!response.ok || !json.success)
    throw new Error(
      `Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(json.errors)}`,
    );
  return json.result;
}
let database = (await api("/d1/database?per_page=100")).find(
  (d) => d.name === "envol",
);
if (!database) database = await api("/d1/database", "POST", { name: "envol" });
config.d1_databases[0].database_id = database.uuid;
const buckets = await api("/r2/buckets");
if (!buckets.buckets.some((b) => b.name === "envol-artifacts"))
  await api("/r2/buckets", "POST", { name: "envol-artifacts" });
// Custom domain is attached once in the dashboard; keep the deploy token free of DNS write access.
delete config.routes;
await writeFile("wrangler.ci.json", JSON.stringify(config, null, 2));
console.log(`Envol storage ready; using D1 ${database.uuid}`);
