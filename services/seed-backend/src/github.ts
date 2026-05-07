export interface GithubValidationResult {
  ok: boolean;
  normalizedUrl?: string;
  owner?: string;
  repo?: string;
  reason?: string;
}

const CODE_EXTENSIONS = new Set([
  ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".kt", ".swift",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".sol", ".move", ".toml", ".json",
  ".yaml", ".yml", ".svelte", ".vue",
]);

export function parseGithubUrl(raw: string): GithubValidationResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "github URL is not syntactically valid" };
  }

  if (url.hostname.toLowerCase() !== "github.com") {
    return { ok: false, reason: "github URL must use github.com domain" };
  }

  const [owner, repoRaw] = url.pathname.split("/").filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/i, "");
  if (!owner || !repo) {
    return { ok: false, reason: "github URL must point to owner/repo" };
  }

  return {
    ok: true,
    owner,
    repo,
    normalizedUrl: `https://github.com/${owner}/${repo}`,
  };
}

export async function validateGithubRepo(rawUrl: string): Promise<GithubValidationResult> {
  const parsed = parseGithubUrl(rawUrl);
  if (!parsed.ok || !parsed.owner || !parsed.repo) return parsed;
  const { config } = await import("./config.js");

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "vara-agent-network-seed-backend",
  };
  if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;

  const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
  const repoRes = await fetch(base, { headers });
  if (repoRes.status === 404) return { ...parsed, ok: false, reason: "github repo does not exist or is private" };
  if (!repoRes.ok) return { ...parsed, ok: false, reason: `github repo check failed with ${repoRes.status}` };

  const repo = await repoRes.json() as {
    private?: boolean;
    size?: number;
    pushed_at?: string;
    default_branch?: string;
  };
  if (repo.private) return { ...parsed, ok: false, reason: "github repo is private" };
  if (!repo.size || repo.size <= 0) return { ...parsed, ok: false, reason: "github repo is empty" };

  const pushedAt = repo.pushed_at ? Date.parse(repo.pushed_at) : 0;
  const recentAfter = Date.now() - config.recentCommitDays * 24 * 60 * 60 * 1000;
  if (!pushedAt || pushedAt < recentAfter) {
    return { ...parsed, ok: false, reason: `github repo has no commits in last ${config.recentCommitDays} days` };
  }

  const branch = encodeURIComponent(repo.default_branch ?? "main");
  const treeRes = await fetch(`${base}/git/trees/${branch}?recursive=1`, { headers });
  if (!treeRes.ok) return { ...parsed, ok: false, reason: `github tree check failed with ${treeRes.status}` };

  const tree = await treeRes.json() as {
    tree?: Array<{ path?: string; type?: string; size?: number }>;
  };
  const files = tree.tree?.filter((entry) => entry.type === "blob" && entry.path) ?? [];
  const hasReadme = files.some((entry) => /^readme(\.|$)/i.test(entry.path!.split("/").pop() ?? ""));
  if (!hasReadme) return { ...parsed, ok: false, reason: "github repo has no README" };

  const codeFiles = files.filter((entry) => {
    const path = entry.path!.toLowerCase();
    return [...CODE_EXTENSIONS].some((ext) => path.endsWith(ext));
  });
  if (codeFiles.length < 2) {
    return { ...parsed, ok: false, reason: "github repo does not contain enough code files" };
  }

  const totalCodeBytes = codeFiles.reduce((sum, entry) => sum + Number(entry.size ?? 0), 0);
  if (totalCodeBytes < 1024) {
    return { ...parsed, ok: false, reason: "github repo looks like a placeholder" };
  }

  return parsed;
}
