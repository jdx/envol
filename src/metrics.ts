import type { Database } from "./db.ts";
export interface Observation {
  source: string;
  metric: string;
  day: string;
  value: number;
}
export function csvRows(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(field);
      field = "";
    } else if (c === "\n" && !quoted) {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("Unterminated CSV quote");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return rows
    .filter((r) => r.length === headers.length)
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}
export function analyticsRows(text: string, repoName: string): Observation[] {
  const mappings: Record<string, [string, string]> = {
    github_stars: ["github", "stars"],
    release_downloads: ["github", "downloads"],
    brew_installs: ["homebrew", "installs_30d"],
    brew_rank: ["homebrew", "rank"],
  };
  return csvRows(text)
    .filter(
      (row) =>
        row.repo_name === repoName && /^\d{4}-\d{2}-\d{2}$/.test(row.date),
    )
    .flatMap((row) =>
      Object.entries(mappings).flatMap(([column, [source, metric]]) => {
        const value = Number(row[column]);
        return row[column] !== undefined &&
          row[column] !== "" &&
          Number.isFinite(value) &&
          value >= 0
          ? [{ source, metric, day: row.date, value }]
          : [];
      }),
    );
}
export async function saveObservations(
  db: Database,
  project: string,
  points: Observation[],
) {
  for (let i = 0; i < points.length; i += 80)
    await db.batch(
      points.slice(i, i + 80).map((p) => ({
        sql: "INSERT INTO metrics VALUES(?,?,?,?,?) ON CONFLICT(project_id,source,metric,day) DO UPDATE SET value=excluded.value",
        params: [project, p.source, p.metric, p.day, p.value],
      })),
    );
}
export async function importMiseAnalytics(
  db: Database,
  project: string,
  repoName: string,
) {
  const points: Observation[] = [];
  for (const file of ["top-repos.csv", "top-repos-downloads.csv"]) {
    const response = await fetch(
      `https://raw.githubusercontent.com/jdx/mise-analytics/main/${file}`,
    );
    if (!response.ok)
      throw new Error(`mise-analytics fetch failed: ${response.status}`);
    points.push(...analyticsRows(await response.text(), repoName));
  }
  await saveObservations(db, project, points);
  return points.length;
}
export function dailyDeltas(points: { day: string; value: number }[]) {
  return [...points]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((point, i, all) => {
      const previous = all[i - 1];
      return {
        ...point,
        value:
          previous &&
          Date.parse(point.day) - Date.parse(previous.day) === 86400000 &&
          point.value >= previous.value
            ? point.value - previous.value
            : null,
      };
    });
}
export function milestone(points: { day: string; value: number }[]) {
  const sorted = [...points].sort((a, b) => a.day.localeCompare(b.day));
  const latest = sorted.at(-1);
  if (!latest) return null;
  const scale = 10 ** Math.floor(Math.log10(Math.max(latest.value, 1))),
    target =
      [1, 2, 5, 10].map((n) => n * scale).find((n) => n > latest.value) ??
      scale * 10;
  const cutoff = new Date(Date.parse(latest.day) - 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  const previous = sorted.findLast((point) => point.day <= cutoff);
  const span = previous
    ? (Date.parse(latest.day) - Date.parse(previous.day)) / 86400000
    : 0;
  const rate =
    previous && span > 0 ? (latest.value - previous.value) / span : 0;
  return {
    target,
    current: latest.value,
    asOf: latest.day,
    days: rate > 0 ? Math.ceil((target - latest.value) / rate) : null,
    method:
      "Projection based on the trailing 30-day net growth rate; growth can change.",
  };
}
