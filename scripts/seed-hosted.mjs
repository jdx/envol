// Hosted pilot only; self-hosted deployments start empty.
import { readFile } from "node:fs/promises";
const config = JSON.parse(await readFile("wrangler.ci.json", "utf8"));
const token = process.env.CLOUDFLARE_API_TOKEN;
const names = ["mise", "hk", "fnox", "aube", "usage", "envol"];
for (const name of names) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/d1/database/${config.d1_databases[0].database_id}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sql: "INSERT INTO projects(id,repo,installation_id,public,config,created_at) VALUES(?,?,0,1,?,?) ON CONFLICT(repo) DO NOTHING",
        params: [
          `jdx-${name}`,
          `jdx/${name}`,
          JSON.stringify({
            lines: {},
            required_artifacts: [],
            version_files: [],
            workflow: "envol.yml",
            auto_promote: false,
          }),
          new Date().toISOString(),
        ],
      }),
    },
  );
  if (!response.ok)
    throw new Error(`Could not seed ${name}: ${response.status}`);
  const result = await response.json();
  if (!result.success) throw new Error(`Seed failed for ${name}`);
}
