export function publishGitHubRelease(options: {
  token: string;
  repo: string;
  tag: string;
  directory: string;
}): Promise<string>;
