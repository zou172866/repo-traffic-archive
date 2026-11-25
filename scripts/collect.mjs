import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBadgeJson,
  buildSummary,
  filterPublicRepos,
  hasSummaryChanged,
  markInactiveLedger,
  mergeDailyClones,
  renderReadmeSection,
  sanitizeRepoFileName,
  stableStringify,
  updateReadmeContent,
} from './lib.mjs';

const DEFAULT_API_BASE_URL = 'https://api.github.com';
const MAX_PAGINATION_PAGES = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).trim().toLowerCase() === 'true';
}

function parseCsvList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Extract rel="next" URL from an HTTP Link header (RFC 8288 compliant).
 */
export function parseNextLink(linkHeader) {
  if (typeof linkHeader !== 'string' || !linkHeader) return null;
  const linkEntryRe = /<([^>]+)>([^<]*)/g;
  let match;
  while ((match = linkEntryRe.exec(linkHeader)) !== null) {
    const url = match[1].trim();
    const params = match[2];
    const relMatch = params.match(/;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i);
    if (!relMatch) continue;
    const relTokens = (relMatch[1] ?? relMatch[2] ?? '')
      .trim()
      .toLowerCase()
      .split(/\s+/);
    if (relTokens.includes('next')) {
      return url;
    }
  }
  return null;
}

/**
 * Determine whether to query /installation/repositories (GitHub App) or /users|/orgs (PAT).
 */
export function detectAuthMode(token, authMode = 'auto') {
  const mode = String(authMode || 'auto').trim().toLowerCase();
  if (mode === 'app' || mode === 'pat') return mode;
  return String(token || '').startsWith('ghs_') ? 'app' : 'pat';
}

function assertSameOrigin(targetUrl, baseUrl) {
  const baseOrigin = new URL(baseUrl).origin;
  const resolved = new URL(targetUrl, baseUrl);
  if (resolved.origin !== baseOrigin) {
    throw new Error(
      `Refusing to follow cross-origin pagination link: ${resolved.origin} !== ${baseOrigin}`,
    );
  }
  return resolved.href;
}

function isRateLimited403(response) {
  if (response.status !== 403) return false;
  const retryAfter = response.headers?.get?.('retry-after');
  if (retryAfter !== null && retryAfter !== undefined && String(retryAfter).trim() !== '') {
    return true;
  }
  const remaining = response.headers?.get?.('x-ratelimit-remaining');
  return String(remaining ?? '').trim() === '0';
}

function computeRetryDelayMs(response, attempt, retryDelayMs) {
  const retryAfterRaw = response.headers?.get?.('retry-after');
  if (retryAfterRaw) {
    const retryAfterSec = Number(retryAfterRaw);
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      return Math.min(retryAfterSec * 1000, 30_000);
    }
    const retryAfterDateMs = Date.parse(retryAfterRaw);
    if (Number.isFinite(retryAfterDateMs)) {
      const deltaMs = retryAfterDateMs - Date.now();
      if (deltaMs > 0) {
        return Math.min(deltaMs, 30_000);
      }
    }
  }

  const remaining = response.headers?.get?.('x-ratelimit-remaining');
  const resetRaw = response.headers?.get?.('x-ratelimit-reset');
  if (String(remaining ?? '').trim() === '0' && resetRaw) {
    const resetEpochSec = Number(resetRaw);
    if (Number.isFinite(resetEpochSec)) {
      const deltaMs = resetEpochSec * 1000 - Date.now();
      if (deltaMs > 0) {
        return Math.min(deltaMs, 30_000);
      }
    }
  }

  return retryDelayMs * 2 ** attempt;
}

/**
 * Perform a GitHub REST API GET request with retry on transient network/5xx/429/rate-limited-403 errors.
 */
export async function githubRequest(
  url,
  {
    token,
    fetchImpl = globalThis.fetch,
    maxRetries = 3,
    retryDelayMs = 1000,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    allowStatuses = [],
  } = {},
) {
  const allowed = new Set(allowStatuses);
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'repo-traffic-archive/1.0',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const fetchOptions = { method: 'GET', headers };
      if (requestTimeoutMs > 0 && typeof AbortSignal?.timeout === 'function') {
        fetchOptions.signal = AbortSignal.timeout(requestTimeoutMs);
      }
      const response = await fetchImpl(url, fetchOptions);

      if (response.ok) {
        const data = response.status === 204 ? null : await response.json();
        return { ok: true, status: response.status, headers: response.headers, data };
      }

      const rateLimited403 = isRateLimited403(response);
      if (allowed.has(response.status) && !rateLimited403) {
        let errorMessage = '';
        try {
          const errBody = await response.json();
          errorMessage = errBody?.message || '';
        } catch {
          // Ignore non-JSON body for allowed status codes
        }
        return {
          ok: false,
          status: response.status,
          headers: response.headers,
          data: null,
          message: errorMessage,
        };
      }

      const bodyText = await response.text();
      if ((RETRYABLE_STATUSES.has(response.status) || rateLimited403) && attempt < maxRetries) {
        if (retryDelayMs > 0) {
          await sleep(computeRetryDelayMs(response, attempt, retryDelayMs));
        }
        continue;
      }

      throw new Error(`GitHub API HTTP ${response.status} for ${url}: ${bodyText.slice(0, 500)}`);
    } catch (err) {
      lastError = err;
      const isHttpFailure = err instanceof Error && err.message.startsWith('GitHub API HTTP ');
      if (isHttpFailure || attempt >= maxRetries) {
        throw err;
      }
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs * 2 ** attempt);
      }
    }
  }

  throw lastError;
}

/**
 * Follow Link rel="next" pagination across GitHub REST endpoints.
 * Supports both raw array payloads and { repositories: [...] } installation responses.
 */
export async function fetchAllPages(
  initialUrl,
  { token, apiBaseUrl = DEFAULT_API_BASE_URL, fetchImpl = globalThis.fetch, maxRetries = 3, retryDelayMs = 1000 } = {},
) {
  const items = [];
  const visited = new Set();
  let nextUrl = initialUrl;
  let pages = 0;

  while (nextUrl) {
    const resolvedUrl = assertSameOrigin(nextUrl, apiBaseUrl);
    if (visited.has(resolvedUrl)) {
      throw new Error(`Pagination cycle detected at ${resolvedUrl}`);
    }
    if (pages >= MAX_PAGINATION_PAGES) {
      throw new Error(`Exceeded maximum pagination limit (${MAX_PAGINATION_PAGES} pages).`);
    }

    visited.add(resolvedUrl);
    pages += 1;

    const result = await githubRequest(resolvedUrl, {
      token,
      fetchImpl,
      maxRetries,
      retryDelayMs,
    });

    if (Array.isArray(result.data)) {
      items.push(...result.data);
    } else if (result.data && Array.isArray(result.data.repositories)) {
      items.push(...result.data.repositories);
    } else {
      throw new Error(`Unexpected paginated response shape from ${resolvedUrl}`);
    }

    const linkHeader = result.headers?.get?.('link') ?? '';
    nextUrl = parseNextLink(linkHeader);
  }

  return items;
}

/**
 * List candidate repositories using either GitHub App installation endpoint or PAT User/Org endpoint.
 */
export async function fetchOwnerRepos({
  token,
  owner,
  authMode = 'auto',
  apiBaseUrl = DEFAULT_API_BASE_URL,
  fetchImpl = globalThis.fetch,
  maxRetries = 3,
  retryDelayMs = 1000,
}) {
  const base = apiBaseUrl.replace(/\/+$/, '');
  const mode = detectAuthMode(token, authMode);

  if (mode === 'app') {
    const repos = await fetchAllPages(`${base}/installation/repositories?per_page=100`, {
      token,
      apiBaseUrl: base,
      fetchImpl,
      maxRetries,
      retryDelayMs,
    });
    return { mode, repos };
  }

  if (!owner) {
    throw new Error('GITHUB_OWNER (or GITHUB_REPOSITORY) is required when running in PAT mode.');
  }

  const encodedOwner = encodeURIComponent(owner);
  const accountRes = await githubRequest(`${base}/users/${encodedOwner}`, {
    token,
    fetchImpl,
    maxRetries,
    retryDelayMs,
  });

  const isOrg = accountRes.data?.type === 'Organization';
  const listUrl = isOrg
    ? `${base}/orgs/${encodedOwner}/repos?type=public&per_page=100`
    : `${base}/users/${encodedOwner}/repos?type=owner&per_page=100`;

  const repos = await fetchAllPages(listUrl, {
    token,
    apiBaseUrl: base,
    fetchImpl,
    maxRetries,
    retryDelayMs,
  });
  return { mode, accountType: isOrg ? 'Organization' : 'User', repos };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeFileIfChanged(filePath, content) {
  const normalized = String(content).replace(/\r\n?/g, '\n');
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing === normalized) {
      return false;
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, normalized, 'utf8');
  return true;
}

function renameExactFileIfPresent(dirPath, oldFileName, newFileName) {
  if (!oldFileName || !newFileName || oldFileName === newFileName) return false;
  if (!fs.existsSync(dirPath)) return false;
  const entries = fs.readdirSync(dirPath);
  if (!entries.includes(oldFileName)) return false;
  fs.renameSync(path.join(dirPath, oldFileName), path.join(dirPath, newFileName));
  return true;
}

function loadExistingDailyLedgers(dailyDir) {
  const map = new Map();
  if (!fs.existsSync(dailyDir)) return map;

  const entries = fs
    .readdirSync(dailyDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fullPath = path.join(dailyDir, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse existing daily ledger ${fullPath}: ${err.message}`);
    }
    const baseName = entry.name.slice(0, -'.json'.length);
    const key = String(parsed?.name || baseName).toLowerCase();
    if (map.has(key)) {
      const existing = map.get(key);
      throw new Error(
        `Duplicate case-variant daily ledgers detected for "${key}": ${existing.fileName} and ${entry.name}`,
      );
    }
    map.set(key, { ledger: parsed, fileName: entry.name, fullPath });
  }
  return map;
}

/**
 * Run a full collection cycle: fetch public repos & clone traffic, merge ledgers,
 * preserve historical inactive repos, write daily JSONs, summary, badges, and README.md.
 */
export async function runCollect({
  rootDir = process.cwd(),
  token = process.env.GITHUB_TOKEN || process.env.TRAFFIC_TOKEN || '',
  owner = process.env.GITHUB_OWNER || (process.env.GITHUB_REPOSITORY?.split('/')[0] ?? ''),
  archiveRepo = process.env.ARCHIVE_REPO || process.env.GITHUB_REPOSITORY || '',
  authMode = process.env.AUTH_MODE || 'auto',
  includeForks = parseBool(process.env.INCLUDE_FORKS, false),
  includeArchiveRepo = parseBool(process.env.INCLUDE_ARCHIVE_REPO, false),
  excludeRepos = parseCsvList(process.env.EXCLUDE_REPOS),
  badgeNumberStyle = process.env.BADGE_NUMBER_STYLE || 'exact',
  badgeColor = process.env.BADGE_COLOR || '0969da',
  heartbeatCommit = parseBool(process.env.HEARTBEAT_COMMIT, false),
  branch = process.env.DEFAULT_BRANCH || process.env.GITHUB_REF_NAME || 'main',
  apiBaseUrl = process.env.API_BASE_URL || process.env.GITHUB_API_URL || DEFAULT_API_BASE_URL,
  fetchedAtUtc = new Date().toISOString(),
  fetchImpl = globalThis.fetch,
  maxRetries = 3,
  retryDelayMs = 1000,
  logger = console,
} = {}) {
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to query GitHub traffic API.');
  }

  const base = apiBaseUrl.replace(/\/+$/, '');
  const cleanArchiveRepo = String(archiveRepo || '').trim();
  const archiveShortName = cleanArchiveRepo.includes('/')
    ? cleanArchiveRepo.split('/')[1]
    : cleanArchiveRepo;
  const archiveFullName = cleanArchiveRepo
    ? cleanArchiveRepo.includes('/')
      ? cleanArchiveRepo
      : owner
        ? `${owner}/${cleanArchiveRepo}`
        : cleanArchiveRepo
    : '';

  const effectiveExcludeRepos = [...parseCsvList(excludeRepos)];
  if (!includeArchiveRepo) {
    const archiveExcludeTarget = archiveFullName.includes('/')
      ? archiveFullName
      : archiveShortName;
    if (archiveExcludeTarget) {
      effectiveExcludeRepos.push(archiveExcludeTarget);
    }
  }

  const { mode, repos: rawRepos } = await fetchOwnerRepos({
    token,
    owner,
    authMode,
    apiBaseUrl: base,
    fetchImpl,
    maxRetries,
    retryDelayMs,
  });

  const targetRepos = filterPublicRepos(rawRepos, {
    owner,
    includeForks,
    excludeRepos: effectiveExcludeRepos,
  });

  logger.log(
    `[collect] auth=${mode} owner=${owner || '(all)'} fetched=${rawRepos.length} eligible_public=${targetRepos.length}`,
  );

  const dataDir = path.join(rootDir, 'data');
  const dailyDir = path.join(dataDir, 'daily');
  const badgesDir = path.join(rootDir, 'badges');
  const summaryPath = path.join(dataDir, 'summary.json');
  const readmePath = path.join(rootDir, 'README.md');

  const existingDailyMap = loadExistingDailyLedgers(dailyDir);
  const seenKeys = new Set();
  const renamedRepoBadges = new Map();
  const allLedgers = [];
  const skippedRepos = [];
  const filesWritten = [];

  for (const repo of targetRepos) {
    const repoOwner = repo.owner?.login || owner;
    const repoFullName = repo.full_name || `${repoOwner}/${repo.name}`;
    const safeName = sanitizeRepoFileName(repo.name);
    const key = safeName.toLowerCase();
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    const existingEntry = existingDailyMap.get(key) || null;
    const trafficUrl = `${base}/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repo.name)}/traffic/clones?per=day`;

    const trafficRes = await githubRequest(trafficUrl, {
      token,
      fetchImpl,
      maxRetries,
      retryDelayMs,
      allowStatuses: [403, 404],
    });

    if (!trafficRes.ok) {
      logger.warn(
        `[collect] Skipping ${repoFullName}: HTTP ${trafficRes.status}${trafficRes.message ? ` (${trafficRes.message})` : ''}; preserving existing ledger if present.`,
      );
      skippedRepos.push({ repo: repoFullName, status: trafficRes.status });
      if (existingEntry?.ledger) {
        allLedgers.push(existingEntry.ledger);
      }
      continue;
    }

    const apiClones = Array.isArray(trafficRes.data?.clones) ? trafficRes.data.clones : [];
    const { ledger, dataChanged } = mergeDailyClones(existingEntry?.ledger ?? null, apiClones, {
      repoFullName,
      repoMeta: {
        name: safeName,
        full_name: repoFullName,
        html_url: repo.html_url,
        archived: repo.archived,
        visibility: repo.visibility,
      },
      fetchedAtUtc,
    });

    allLedgers.push(ledger);
    const targetFileName = `${safeName}.json`;
    const ledgerPath = path.join(dailyDir, targetFileName);
    let renamedLedger = false;
    if (existingEntry && existingEntry.fileName !== targetFileName) {
      renamedLedger = renameExactFileIfPresent(dailyDir, existingEntry.fileName, targetFileName);
      const oldBaseName = existingEntry.fileName.slice(0, -'.json'.length);
      if (oldBaseName !== safeName) {
        renamedRepoBadges.set(key, { oldBaseName, newBaseName: safeName });
      }
    }

    if (dataChanged || renamedLedger || !fs.existsSync(ledgerPath)) {
      const wrote = writeFileIfChanged(ledgerPath, stableStringify(ledger));
      if (wrote || renamedLedger) {
        filesWritten.push(path.relative(rootDir, ledgerPath).replace(/\\/g, '/'));
      }
    }
  }

  if (targetRepos.length > 0 && skippedRepos.length === targetRepos.length) {
    logger.warn(
      '[collect] All eligible public repositories returned HTTP 403/404 for traffic/clones. Verify the token grants Repository permission "Administration: Read-only".',
    );
  }

  // Preserve previously tracked repositories that disappeared, were privatized, or excluded
  for (const [key, existingEntry] of existingDailyMap.entries()) {
    if (seenKeys.has(key)) continue;
    const { ledger, dataChanged } = markInactiveLedger(existingEntry.ledger, { fetchedAtUtc });
    allLedgers.push(ledger);

    const safeName = sanitizeRepoFileName(ledger.name || existingEntry.fileName.replace(/\.json$/, ''));
    const targetFileName = `${safeName}.json`;
    const ledgerPath = path.join(dailyDir, targetFileName);
    let renamedLedger = false;
    if (existingEntry.fileName !== targetFileName) {
      renamedLedger = renameExactFileIfPresent(dailyDir, existingEntry.fileName, targetFileName);
      const oldBaseName = existingEntry.fileName.slice(0, -'.json'.length);
      if (oldBaseName !== safeName) {
        renamedRepoBadges.set(key, { oldBaseName, newBaseName: safeName });
      }
    }
    if (dataChanged || renamedLedger || !fs.existsSync(ledgerPath)) {
      const wrote = writeFileIfChanged(ledgerPath, stableStringify(ledger));
      if (wrote || renamedLedger) {
        filesWritten.push(path.relative(rootDir, ledgerPath).replace(/\\/g, '/'));
      }
    }
  }

  const prevSummary = readJsonIfExists(summaryPath);
  const candidateSummary = buildSummary(allLedgers, {
    owner,
    archiveRepo: archiveFullName,
    generatedAtUtc: fetchedAtUtc,
    includeForks,
    excludeRepos: effectiveExcludeRepos,
  });

  const summaryChanged = hasSummaryChanged(prevSummary, candidateSummary);
  const finalSummary =
    !summaryChanged && !heartbeatCommit && prevSummary?.generated_at_utc
      ? { ...candidateSummary, generated_at_utc: prevSummary.generated_at_utc }
      : candidateSummary;

  if (summaryChanged || heartbeatCommit || !fs.existsSync(summaryPath)) {
    if (writeFileIfChanged(summaryPath, stableStringify(finalSummary))) {
      filesWritten.push(path.relative(rootDir, summaryPath).replace(/\\/g, '/'));
    }
  }

  // Write account-wide total badge
  const totalBadgePath = path.join(badgesDir, 'total-clones.json');
  const totalBadgeJson = buildBadgeJson({
    label: 'total clones',
    count: finalSummary.total_cumulative_clones,
    color: badgeColor,
    numberStyle: badgeNumberStyle,
  });
  if (writeFileIfChanged(totalBadgePath, stableStringify(totalBadgeJson))) {
    filesWritten.push(path.relative(rootDir, totalBadgePath).replace(/\\/g, '/'));
  }

  // Write per-repository badges
  for (const ledger of allLedgers) {
    const safeName = sanitizeRepoFileName(ledger.name);
    const key = safeName.toLowerCase();
    if (key === 'total-clones') {
      logger.warn(
        '[collect] Repository name "total-clones" collides with account total badge badges/total-clones.json; skipping per-repo badge file.',
      );
      continue;
    }
    const renameInfo = renamedRepoBadges.get(key);
    let renamedBadge = false;
    if (renameInfo && renameInfo.oldBaseName !== safeName) {
      renamedBadge = renameExactFileIfPresent(
        badgesDir,
        `${renameInfo.oldBaseName}.json`,
        `${safeName}.json`,
      );
    }
    const repoBadgePath = path.join(badgesDir, `${safeName}.json`);
    const repoBadgeJson = buildBadgeJson({
      label: 'clones',
      count: ledger.cumulative_clones,
      color: badgeColor,
      numberStyle: badgeNumberStyle,
    });
    const wroteBadge = writeFileIfChanged(repoBadgePath, stableStringify(repoBadgeJson));
    if (wroteBadge || renamedBadge) {
      filesWritten.push(path.relative(rootDir, repoBadgePath).replace(/\\/g, '/'));
    }
  }

  // Update README.md table section
  const existingReadme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';
  const readmeSection = renderReadmeSection(finalSummary, {
    owner,
    archiveRepo: archiveFullName,
    branch,
  });
  const nextReadme = updateReadmeContent(existingReadme, readmeSection);
  if (writeFileIfChanged(readmePath, nextReadme)) {
    filesWritten.push('README.md');
  }

  logger.log(
    `[collect] Done. total_cumulative_clones=${finalSummary.total_cumulative_clones} active=${finalSummary.active_public_repos} inactive=${finalSummary.historical_inactive_repos} skipped=${skippedRepos.length} files_written=${filesWritten.length}`,
  );

  return {
    fetchedAtUtc,
    mode,
    activeCount: finalSummary.active_public_repos,
    inactiveCount: finalSummary.historical_inactive_repos,
    skippedRepos,
    filesWritten,
    summary: finalSummary,
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
  runCollect().catch((err) => {
    console.error(`[collect] Fatal error: ${err?.stack || err}`);
    process.exitCode = 1;
  });
}
