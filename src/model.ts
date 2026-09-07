import semver from "semver";
import { parse } from "smol-toml";
export type State =
  | "queued"
  | "preparing"
  | "building"
  | "ready"
  | "promoting"
  | "publishing"
  | "released"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "blocked";
export interface Project {
  id: string;
  repo: string;
  installation_id: number;
  public: number;
  config: string;
  created_at: string;
}
export interface Line {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  channel: string;
  ruleset_id: number | null;
  candidate_id: string | null;
}
export interface Candidate {
  id: string;
  line_id: string;
  request_key: string;
  version: string;
  tag: string;
  state: State;
  base_sha: string | null;
  sha: string | null;
  pr: number | null;
  run_id: string | null;
  workflow_ref: string | null;
  error: string | null;
  revision: number;
  frozen: number;
  created_at: string;
  updated_at: string;
}
export interface Artifact {
  candidate_id: string;
  name: string;
  digest: string;
  size: number;
  storage_key: string;
}
export interface Config {
  workflow: string;
  version_files: string[];
  required_artifacts: string[];
  auto_promote: boolean;
  lines: Record<string, { branch: string; channel: string }>;
}
export function configFromToml(text: string): Config {
  const raw = parse(text) as Record<string, unknown>;
  const workflow = raw.workflow ?? "envol.yml";
  const version_files = raw.version_files ?? ["Cargo.toml"];
  const required_artifacts = raw.required_artifacts;
  const lines = raw.lines;
  if (typeof workflow !== "string" || !/^[-\w.]+\.ya?ml$/.test(workflow))
    throw new Error("workflow must be a YAML filename");
  if (
    !Array.isArray(version_files) ||
    !version_files.length ||
    version_files.some(
      (p) =>
        typeof p !== "string" ||
        p.startsWith("/") ||
        p.split("/").includes(".."),
    )
  )
    throw new Error("Invalid version_files");
  if (
    !Array.isArray(required_artifacts) ||
    !required_artifacts.length ||
    required_artifacts.some(
      (p) => typeof p !== "string" || !/^[-\w.]+$/.test(p),
    )
  )
    throw new Error("required_artifacts must list exact artifact filenames");
  if (
    !lines ||
    typeof lines !== "object" ||
    Array.isArray(lines) ||
    !Object.keys(lines).length
  )
    throw new Error("Configure at least one release line");
  const branches = new Set<string>();
  for (const line of Object.values(lines) as {
    branch: unknown;
    channel: unknown;
  }[]) {
    if (
      !line ||
      typeof line.branch !== "string" ||
      !/^[-\w/]+$/.test(line.branch) ||
      typeof line.channel !== "string" ||
      !["stable", "alpha", "beta", "rc"].includes(line.channel)
    )
      throw new Error("Invalid release line");
    if (branches.has(line.branch))
      throw new Error("Each release line requires a different branch");
    branches.add(line.branch);
  }
  return {
    workflow,
    version_files: version_files as string[],
    required_artifacts: required_artifacts as string[],
    auto_promote: raw.auto_promote === true,
    lines: lines as Config["lines"],
  };
}
export function releaseVersion(version: string, channel: string): string {
  const parsed = semver.parse(version);
  if (!parsed || parsed.version !== version || parsed.build.length)
    throw new Error("Use a concrete SemVer version without build metadata");
  if (channel === "stable" && parsed.prerelease.length)
    throw new Error("Stable releases cannot be prereleases");
  if (
    channel !== "stable" &&
    (parsed.prerelease[0] !== channel ||
      parsed.prerelease.length !== 2 ||
      typeof parsed.prerelease[1] !== "number")
  )
    throw new Error(`Use ${channel}.N prerelease versions`);
  return version;
}
export function nextVersion(
  current: string,
  bump: "major" | "minor" | "patch",
  channel = "stable",
) {
  const next =
    channel === "stable"
      ? semver.inc(current, bump)
      : semver.inc(current, `pre${bump}` as semver.ReleaseType, channel, "1");
  if (!next) throw new Error("Invalid current version");
  return next;
}
