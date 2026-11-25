import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CREATE_COMMIT_ON_BRANCH_MUTATION = `
mutation CreateVerifiedCommit($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit {
      oid
      url
    }
  }
}
`.trim();

const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql';
const DEFAULT_PATHSPECS = ['data', 'badges', 'README.md'];
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_GRAPHQL_STATUSES = new Set([429, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRepoPath(filePath) {
  return String(filePath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

/**
 * Parse `git -c core.quotePath=false status --porcelain=v1 -z -uall` output
 * into sorted lists of file paths to add/update vs delete.
 */
export function parseGitStatusPorcelainZ(porcelainOutput) {
  const raw = String(porcelainOutput ?? '');
  if (!raw) {
    return { additionPaths: [], deletionPaths: [] };
  }

  const tokens = raw.split('\0');
  const additions = new Set();
  const deletions = new Set();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.length < 4) continue;

    const x = token[0];
    const y = token[1];
    const currentPath = normalizeRepoPath(token.slice(3));

    if (
      x === 'U' ||
      y === 'U' ||
      (x === 'A' && y === 'A') ||
      (x === 'D' && y === 'D')
    ) {
      throw new Error(
        `Unmerged git conflict detected (${x}${y}) at ${currentPath || '<unknown>'}; refusing to commit.`,
      );
    }

    if (x === 'R' || x === 'C') {
      const oldPath = normalizeRepoPath(tokens[i + 1] ?? '');
      i += 1;
      if (x === 'R' && oldPath) {
        deletions.add(oldPath);
      }
      if (currentPath && y !== 'D') {
        additions.add(currentPath);
      }
      continue;
    }

    if (!currentPath) continue;

    // Added in index then deleted in working tree => net no-op relative to HEAD
    if (x === 'A' && y === 'D') {
      continue;
    }

    if (y === 'D' || (x === 'D' && y === ' ')) {
      deletions.add(currentPath);
    } else {
      additions.add(currentPath);
    }
  }

  // If a path was both deleted (e.g. from rename source) and re-added, keep it as addition
  for (const addedPath of additions) {
    deletions.delete(addedPath);
  }

  return {
    additionPaths: Array.from(additions).sort(),
    deletionPaths: Array.from(deletions).sort(),
  };
}

/**
 * Build the GitHub GraphQL CreateCommitOnBranchInput object.
 */
export function buildCommitInput({
  repoWithOwner,
  branchName,
  headOid,
  headline,
  body = '',
  additions = [],
  deletions = [],
}) {
  const cleanRepo = String(repoWithOwner ?? '').trim();
  if (!cleanRepo || !cleanRepo.includes('/')) {
    throw new Error(`Invalid repositoryNameWithOwner: ${JSON.stringify(repoWithOwner)}`);
  }

  const cleanBranch = String(branchName ?? '')
    .trim()
    .replace(/^refs\/heads\//, '');
  if (!cleanBranch) {
    throw new Error('branchName must be a non-empty branch name.');
  }

  const cleanHeadOid = String(headOid ?? '').trim();
  if (!cleanHeadOid) {
    throw new Error('headOid (expectedHeadOid) is required.');
  }

  const cleanHeadline = String(headline ?? '').trim();
  if (!cleanHeadline) {
    throw new Error('Commit message headline is required.');
  }

  const normalizedAdditions = (Array.isArray(additions) ? additions : [])
    .map((item) => ({
      path: normalizeRepoPath(item.path),
      contents: Buffer.isBuffer(item.contents)
        ? item.contents.toString('base64')
        : String(item.contents ?? ''),
    }))
    .filter((item) => item.path.length > 0)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const normalizedDeletions = (Array.isArray(deletions) ? deletions : [])
    .map((item) => ({
      path: normalizeRepoPath(typeof item === 'string' ? item : item?.path),
    }))
    .filter((item) => item.path.length > 0)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const fileChanges = {};
  if (normalizedAdditions.length > 0) {
    fileChanges.additions = normalizedAdditions;
  }
  if (normalizedDeletions.length > 0) {
    fileChanges.deletions = normalizedDeletions;
  }

  const message = { headline: cleanHeadline };
  const cleanBody = String(body ?? '').trim();
  if (cleanBody) {
    message.body = cleanBody;
  }

  return {
    branch: {
      repositoryNameWithOwner: cleanRepo,
      branchName: cleanBranch,
    },
    message,
    fileChanges,
    expectedHeadOid: cleanHeadOid,
  };
}

/**
 * Append key=value pairs to GitHub Actions $GITHUB_OUTPUT file when set.
 */
export function writeGithubOutput(outputPath, entries) {
  if (!outputPath) return;
  const lines = [];
  for (const [key, value] of Object.entries(entries)) {
    const safeVal = String(value ?? '').replace(/\r?\n/g, ' ');
    lines.push(`${key}=${safeVal}`);
  }
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

/**
 * Inspect git working tree changes under data, badges, README.md and commit atomically
 * via GitHub GraphQL createCommitOnBranch.
 */
export async function commitVerifiedChanges({
  cwd = process.cwd(),
  token = process.env.GITHUB_TOKEN || '',
  repoWithOwner = process.env.GITHUB_REPOSITORY || '',
  branchName = process.env.TARGET_BRANCH || process.env.GITHUB_REF_NAME || '',
  graphqlUrl = process.env.GITHUB_GRAPHQL_URL || DEFAULT_GRAPHQL_URL,
  commitMessage = process.env.COMMIT_MESSAGE || '',
  githubOutputPath = process.env.GITHUB_OUTPUT || '',
  pathspecs = DEFAULT_PATHSPECS,
  nowUtc = new Date().toISOString(),
  fetchImpl = globalThis.fetch,
  maxRetries = 2,
  retryDelayMs = 1000,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  logger = console,
} = {}) {
  const repoRoot = runGit(['rev-parse', '--show-toplevel'], cwd).trim();
  const statusOutput = runGit(
    ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '-uall', '--', ...pathspecs],
    repoRoot,
  );
  const { additionPaths, deletionPaths } = parseGitStatusPorcelainZ(statusOutput);

  if (additionPaths.length === 0 && deletionPaths.length === 0) {
    logger.log('[commit] No changes in tracked archive paths; skipping commit.');
    writeGithubOutput(githubOutputPath, { changed: 'false', commit_sha: '' });
    return { changed: false, commitSha: '', additionsCount: 0, deletionsCount: 0 };
  }

  if (!token) {
    throw new Error('GITHUB_TOKEN is required to create a commit via GraphQL API.');
  }

  const headOid = runGit(['rev-parse', 'HEAD'], repoRoot).trim();
  const resolvedBranch =
    branchName || runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim();

  if (resolvedBranch === 'HEAD') {
    throw new Error(
      'Detached HEAD detected and TARGET_BRANCH/GITHUB_REF_NAME is unset; cannot determine target branch.',
    );
  }

  const additions = [];
  for (const relPath of additionPaths) {
    const absPath = path.join(repoRoot, relPath);
    const stat = fs.lstatSync(absPath);
    if (!stat.isFile()) {
      throw new Error(`Expected regular file for addition path ${relPath}, found non-file or symlink.`);
    }
    additions.push({
      path: relPath,
      contents: fs.readFileSync(absPath).toString('base64'),
    });
  }

  const deletions = deletionPaths.map((relPath) => ({ path: relPath }));
  const dateUtc = String(nowUtc).slice(0, 10);
  const headline =
    commitMessage.trim() || `chore(traffic): update clone archive (${dateUtc} UTC)`;
  const body = `Automated archive update via GitHub GraphQL createCommitOnBranch.\nUpdated/added files: ${additions.length}\nDeleted files: ${deletions.length}`;

  const input = buildCommitInput({
    repoWithOwner,
    branchName: resolvedBranch,
    headOid,
    headline,
    body,
    additions,
    deletions,
  });

  const payload = JSON.stringify({
    query: CREATE_COMMIT_ON_BRANCH_MUTATION,
    variables: { input },
  });

  let rawBody = '';
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const fetchOptions = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
          'User-Agent': 'repo-traffic-archive/1.0',
        },
        body: payload,
      };
      if (requestTimeoutMs > 0 && typeof AbortSignal?.timeout === 'function') {
        fetchOptions.signal = AbortSignal.timeout(requestTimeoutMs);
      }

      const response = await fetchImpl(graphqlUrl, fetchOptions);
      rawBody = await response.text();
      if (response.ok) {
        break;
      }

      if (RETRYABLE_GRAPHQL_STATUSES.has(response.status) && attempt < maxRetries) {
        if (retryDelayMs > 0) {
          const retryAfterRaw = response.headers?.get?.('retry-after');
          const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
          const waitMs =
            Number.isFinite(retryAfterSec) && retryAfterSec > 0
              ? Math.min(retryAfterSec * 1000, 30_000)
              : retryDelayMs * 2 ** attempt;
          await sleep(waitMs);
        }
        continue;
      }

      throw new Error(`GitHub GraphQL HTTP ${response.status}: ${rawBody.slice(0, 1000)}`);
    } catch (err) {
      const isHttpFailure = err instanceof Error && err.message.startsWith('GitHub GraphQL HTTP ');
      if (isHttpFailure || attempt >= maxRetries) {
        throw err;
      }
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs * 2 ** attempt);
      }
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    throw new Error(`Invalid JSON from GitHub GraphQL API: ${err.message}`);
  }

  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    const messages = parsed.errors
      .map((item) => item?.message || JSON.stringify(item))
      .join('; ');
    throw new Error(`GitHub GraphQL createCommitOnBranch failed: ${messages}`);
  }

  const commit = parsed?.data?.createCommitOnBranch?.commit;
  if (!commit?.oid) {
    throw new Error(`GraphQL response missing commit OID: ${rawBody.slice(0, 500)}`);
  }

  writeGithubOutput(githubOutputPath, { changed: 'true', commit_sha: commit.oid });
  logger.log(
    `[commit] Created verified commit ${commit.oid}${commit.url ? ` (${commit.url})` : ''} (+${additions.length}/-${deletions.length} files).`,
  );

  return {
    changed: true,
    commitSha: commit.oid,
    commitUrl: commit.url || '',
    additionsCount: additions.length,
    deletionsCount: deletions.length,
  };
}

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  const entry = path.resolve(process.argv[1]);
  const current = path.resolve(fileURLToPath(metaUrl));
  return process.platform === 'win32'
    ? entry.toLowerCase() === current.toLowerCase()
    : entry === current;
}

if (isMainModule(import.meta.url)) {
  commitVerifiedChanges().catch((err) => {
    console.error(`[commit] Fatal error: ${err?.stack || err}`);
    process.exitCode = 1;
  });
}
