export const README_START_MARKER = '<!-- TRAFFIC_TABLE:START -->';
export const README_END_MARKER = '<!-- TRAFFIC_TABLE:END -->';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Deterministic locale-independent string comparison (case-insensitive primary, code-point tie-break).
 */
export function compareNames(a, b) {
  const strA = String(a ?? '');
  const strB = String(b ?? '');
  const lowerA = strA.toLowerCase();
  const lowerB = strB.toLowerCase();
  if (lowerA < lowerB) return -1;
  if (lowerA > lowerB) return 1;
  if (strA < strB) return -1;
  if (strA > strB) return 1;
  return 0;
}

/**
 * Deterministic JSON serialization with 2-space indent and trailing LF newline.
 */
export function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Validate a GitHub repository name before using it as a local filename segment.
 * Prevents path traversal, control characters, and Windows reserved device names.
 */
export function sanitizeRepoFileName(repoName) {
  if (typeof repoName !== 'string' || repoName.length === 0) {
    throw new Error('Repository name must be a non-empty string.');
  }
  const baseSegment = repoName.split('.')[0];
  if (
    repoName === '.' ||
    repoName === '..' ||
    repoName.includes('..') ||
    repoName.includes('/') ||
    repoName.includes('\\') ||
    repoName.endsWith('.') ||
    !SAFE_REPO_NAME_RE.test(repoName) ||
    WINDOWS_RESERVED_NAME_RE.test(baseSegment)
  ) {
    throw new Error(`Unsafe repository filename: ${JSON.stringify(repoName)}`);
  }
  return repoName;
}

function toNonNegativeInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.trunc(num);
}

function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/i;

function normalizeDateKey(input) {
  if (typeof input !== 'string' || input.length < 10) return null;
  const trimmed = input.trim();
  const match = trimmed.match(ISO_TIMESTAMP_RE);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return null;

  const tz = match[7];
  if (tz && tz.toUpperCase() !== 'Z') {
    const parsedMs = Date.parse(trimmed);
    if (!Number.isFinite(parsedMs)) return null;
    return new Date(parsedMs).toISOString().slice(0, 10);
  }

  const key = trimmed.slice(0, 10);
  return DATE_KEY_RE.test(key) ? key : null;
}

function normalizeDaysMap(rawDays) {
  const entries = [];
  if (rawDays && typeof rawDays === 'object' && !Array.isArray(rawDays)) {
    for (const [rawKey, rawVal] of Object.entries(rawDays)) {
      const key = normalizeDateKey(rawKey);
      if (!key || !rawVal || typeof rawVal !== 'object') continue;
      entries.push([
        key,
        {
          count: toNonNegativeInt(rawVal.count),
          uniques: toNonNegativeInt(rawVal.uniques),
        },
      ]);
    }
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const sorted = {};
  for (const [key, val] of entries) {
    sorted[key] = val;
  }
  return sorted;
}

function areDaysEqual(prevDays, nextDays) {
  if (!prevDays || typeof prevDays !== 'object' || Array.isArray(prevDays)) {
    return Object.keys(nextDays).length === 0;
  }
  const prevKeys = Object.keys(prevDays);
  const nextKeys = Object.keys(nextDays);
  if (prevKeys.length !== nextKeys.length) return false;
  for (let i = 0; i < nextKeys.length; i += 1) {
    const key = nextKeys[i];
    if (prevKeys[i] !== key) return false;
    const prevVal = prevDays[key];
    const nextVal = nextDays[key];
    if (!prevVal || typeof prevVal !== 'object') return false;
    if (prevVal.count !== nextVal.count || prevVal.uniques !== nextVal.uniques) {
      return false;
    }
  }
  return true;
}

function sumDaysMetrics(days) {
  let cumulativeClones = 0;
  let sumOfDailyUniques = 0;
  for (const entry of Object.values(days)) {
    cumulativeClones += entry.count;
    sumOfDailyUniques += entry.uniques;
  }
  return { cumulativeClones, sumOfDailyUniques };
}

function minDateKey(...candidates) {
  let earliest = null;
  for (const candidate of candidates) {
    const key = normalizeDateKey(candidate);
    if (!key) continue;
    if (earliest === null || key < earliest) {
      earliest = key;
    }
  }
  return earliest;
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

function resolveArchiveFullName(owner, archiveRepo) {
  const cleanArchive = String(archiveRepo ?? '').trim();
  const cleanOwner = String(owner ?? '').trim();
  if (!cleanArchive) return '';
  if (cleanArchive.includes('/')) return cleanArchive;
  return cleanOwner ? `${cleanOwner}/${cleanArchive}` : cleanArchive;
}

function escapeMarkdownCell(text) {
  return String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
}

function sanitizeMarkdownUrl(url) {
  const raw = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw.replace(/\s+/g, '%20').replace(/\)/g, '%29');
}

/**
 * Filter GitHub repository objects strictly to public repositories matching policy.
 */
export function filterPublicRepos(
  repos,
  { owner, includeForks = false, excludeRepos = [] } = {},
) {
  if (!Array.isArray(repos)) return [];

  const ownerLower = owner ? String(owner).trim().toLowerCase() : '';
  const excludeSet = new Set(
    (Array.isArray(excludeRepos) ? excludeRepos : [])
      .map((item) => String(item).trim().toLowerCase())
      .filter(Boolean),
  );

  const filtered = [];
  const seenRepos = new Set();
  for (const repo of repos) {
    if (!repo || typeof repo !== 'object' || typeof repo.name !== 'string' || !repo.name) {
      continue;
    }

    // Strictly public only
    if (repo.private !== false) continue;
    if (
      Object.prototype.hasOwnProperty.call(repo, 'visibility') &&
      repo.visibility !== undefined &&
      repo.visibility !== 'public'
    ) {
      continue;
    }

    const repoOwner = (
      repo.owner?.login ??
      (typeof repo.full_name === 'string' && repo.full_name.includes('/')
        ? repo.full_name.split('/')[0]
        : '')
    )
      .trim()
      .toLowerCase();

    if (ownerLower && repoOwner !== ownerLower) {
      continue;
    }

    if (!includeForks && repo.fork === true) {
      continue;
    }

    const nameLower = repo.name.toLowerCase();
    const fullNameLower = (
      typeof repo.full_name === 'string' && repo.full_name
        ? repo.full_name
        : repoOwner
          ? `${repoOwner}/${repo.name}`
          : repo.name
    ).toLowerCase();

    if (excludeSet.has(nameLower) || excludeSet.has(fullNameLower)) {
      continue;
    }

    if (seenRepos.has(fullNameLower)) {
      continue;
    }
    seenRepos.add(fullNameLower);

    filtered.push(repo);
  }

  filtered.sort((a, b) => compareNames(a.name, b.name));
  return filtered;
}

/**
 * Idempotently merge 14-day GitHub traffic clone entries into a permanent daily ledger.
 * Keys strictly by UTC date (YYYY-MM-DD), preserves dates outside the 14-day window forever,
 * and distinguishes cumulative_clones from sum_of_daily_uniques.
 */
export function mergeDailyClones(
  existingLedger,
  apiClones,
  { repoFullName, repoMeta = {}, fetchedAtUtc = new Date().toISOString() } = {},
) {
  const prev = existingLedger && typeof existingLedger === 'object' ? existingLedger : null;
  const explicitFullName = String(repoFullName || repoMeta.full_name || '').trim();
  const resolvedFullName = explicitFullName || String(prev?.repo || '').trim();
  const derivedName = explicitFullName
    ? explicitFullName.includes('/')
      ? explicitFullName.split('/')[1]
      : explicitFullName
    : resolvedFullName.includes('/')
      ? resolvedFullName.split('/')[1]
      : resolvedFullName;
  const resolvedName = String(repoMeta.name || derivedName || prev?.name || '').trim();

  if (!resolvedName) {
    throw new Error('mergeDailyClones requires a repository name via repoFullName or repoMeta.name.');
  }

  const resolvedRepo = resolvedFullName || resolvedName;
  const mergedMap = normalizeDaysMap(prev?.days);

  if (Array.isArray(apiClones)) {
    for (const item of apiClones) {
      if (!item || typeof item !== 'object') continue;
      const dayKey = normalizeDateKey(item.timestamp);
      if (!dayKey) continue;
      mergedMap[dayKey] = {
        count: toNonNegativeInt(item.count),
        uniques: toNonNegativeInt(item.uniques),
      };
    }
  }

  const sortedDays = normalizeDaysMap(mergedMap);
  const dateKeys = Object.keys(sortedDays);
  const earliestDay = dateKeys.length > 0 ? dateKeys[0] : null;
  const trackingSince =
    minDateKey(earliestDay, prev?.tracking_since) ?? normalizeDateKey(fetchedAtUtc);

  const { cumulativeClones, sumOfDailyUniques } = sumDaysMetrics(sortedDays);
  const htmlUrl = String(
    repoMeta.html_url ??
      prev?.html_url ??
      (resolvedRepo.includes('/') ? `https://github.com/${resolvedRepo}` : ''),
  );
  const archived = Boolean(repoMeta.archived ?? prev?.archived ?? false);

  const dataChanged =
    prev === null ||
    prev.active !== true ||
    Object.prototype.hasOwnProperty.call(prev, 'last_seen_missing_utc') ||
    Boolean(prev.archived) !== archived ||
    String(prev.html_url ?? '') !== htmlUrl ||
    (prev.tracking_since ?? null) !== trackingSince ||
    String(prev.repo ?? '') !== resolvedRepo ||
    String(prev.name ?? '') !== resolvedName ||
    prev.visibility !== 'public' ||
    prev.cumulative_clones !== cumulativeClones ||
    prev.sum_of_daily_uniques !== sumOfDailyUniques ||
    !areDaysEqual(prev.days, sortedDays);

  const lastUpdatedUtc = dataChanged
    ? fetchedAtUtc
    : String(prev?.last_updated_utc || fetchedAtUtc);

  const ledger = {
    schema_version: 1,
    repo: resolvedRepo,
    name: resolvedName,
    html_url: htmlUrl,
    visibility: 'public',
    active: true,
    archived,
    tracking_since: trackingSince,
    cumulative_clones: cumulativeClones,
    sum_of_daily_uniques: sumOfDailyUniques,
    last_updated_utc: lastUpdatedUtc,
    days: sortedDays,
  };

  return { ledger, dataChanged };
}

/**
 * Mark a previously tracked ledger as inactive while permanently preserving all historical days and totals.
 */
export function markInactiveLedger(
  existingLedger,
  { fetchedAtUtc = new Date().toISOString() } = {},
) {
  if (!existingLedger || typeof existingLedger !== 'object') {
    throw new TypeError('markInactiveLedger requires an existing ledger object.');
  }

  const sortedDays = normalizeDaysMap(existingLedger.days);
  const dateKeys = Object.keys(sortedDays);
  const earliestDay = dateKeys.length > 0 ? dateKeys[0] : null;
  const trackingSince =
    minDateKey(earliestDay, existingLedger.tracking_since) ?? normalizeDateKey(fetchedAtUtc);

  const { cumulativeClones, sumOfDailyUniques } = sumDaysMetrics(sortedDays);
  const alreadyInactiveWithTimestamp =
    existingLedger.active === false &&
    typeof existingLedger.last_seen_missing_utc === 'string' &&
    existingLedger.last_seen_missing_utc.length > 0;

  const lastSeenMissingUtc = alreadyInactiveWithTimestamp
    ? existingLedger.last_seen_missing_utc
    : fetchedAtUtc;

  const dataChanged =
    !alreadyInactiveWithTimestamp ||
    existingLedger.cumulative_clones !== cumulativeClones ||
    existingLedger.sum_of_daily_uniques !== sumOfDailyUniques ||
    (existingLedger.tracking_since ?? null) !== trackingSince ||
    !areDaysEqual(existingLedger.days, sortedDays);

  const lastUpdatedUtc = dataChanged
    ? fetchedAtUtc
    : String(existingLedger.last_updated_utc || fetchedAtUtc);

  const resolvedRepo = String(existingLedger.repo || existingLedger.name || '').trim();
  const resolvedName = String(
    existingLedger.name ||
      (resolvedRepo.includes('/') ? resolvedRepo.split('/')[1] : resolvedRepo),
  ).trim();

  const ledger = {
    schema_version: 1,
    repo: resolvedRepo,
    name: resolvedName,
    html_url: String(existingLedger.html_url ?? ''),
    visibility: String(existingLedger.visibility || 'public'),
    active: false,
    archived: Boolean(existingLedger.archived ?? false),
    tracking_since: trackingSince,
    cumulative_clones: cumulativeClones,
    sum_of_daily_uniques: sumOfDailyUniques,
    last_updated_utc: lastUpdatedUtc,
    last_seen_missing_utc: lastSeenMissingUtc,
    days: sortedDays,
  };

  return { ledger, dataChanged };
}

/**
 * Aggregate all active and historical ledgers into the repository summary snapshot.
 */
export function buildSummary(
  ledgers,
  {
    owner = '',
    archiveRepo = '',
    generatedAtUtc = new Date().toISOString(),
    includeForks = false,
    excludeRepos = [],
  } = {},
) {
  const list = Array.isArray(ledgers) ? ledgers : [];
  let totalCumulativeClones = 0;
  let totalSumOfDailyUniques = 0;
  let activePublicRepos = 0;
  let historicalInactiveRepos = 0;
  let earliestTrackingSince = null;

  const repoEntries = list.map((ledger) => {
    const cumulativeClones = toNonNegativeInt(ledger.cumulative_clones);
    const sumOfDailyUniques = toNonNegativeInt(ledger.sum_of_daily_uniques);
    const isActive = ledger.active === true;

    totalCumulativeClones += cumulativeClones;
    totalSumOfDailyUniques += sumOfDailyUniques;
    if (isActive) {
      activePublicRepos += 1;
    } else {
      historicalInactiveRepos += 1;
    }

    earliestTrackingSince = minDateKey(earliestTrackingSince, ledger.tracking_since);

    const entry = {
      name: String(ledger.name ?? ''),
      repo: String(ledger.repo ?? ''),
      html_url: String(ledger.html_url ?? ''),
      active: isActive,
      archived: Boolean(ledger.archived ?? false),
      tracking_since: ledger.tracking_since ?? null,
      days_recorded:
        ledger.days && typeof ledger.days === 'object' ? Object.keys(ledger.days).length : 0,
      cumulative_clones: cumulativeClones,
      sum_of_daily_uniques: sumOfDailyUniques,
      last_updated_utc: String(ledger.last_updated_utc ?? ''),
    };
    if (!isActive) {
      entry.last_seen_missing_utc = ledger.last_seen_missing_utc ?? null;
    }
    return entry;
  });

  repoEntries.sort((a, b) => {
    if (b.cumulative_clones !== a.cumulative_clones) {
      return b.cumulative_clones - a.cumulative_clones;
    }
    return compareNames(a.name, b.name);
  });

  const excludedByLower = new Map();
  for (const item of Array.isArray(excludeRepos) ? excludeRepos : []) {
    const clean = String(item).trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!excludedByLower.has(key)) {
      excludedByLower.set(key, clean);
    }
  }
  const normalizedExcluded = Array.from(excludedByLower.values()).sort(compareNames);

  return {
    schema_version: 1,
    owner: String(owner ?? ''),
    archive_repo: String(archiveRepo ?? ''),
    generated_at_utc: String(generatedAtUtc),
    tracking_since: earliestTrackingSince,
    active_public_repos: activePublicRepos,
    historical_inactive_repos: historicalInactiveRepos,
    total_tracked_repos: repoEntries.length,
    total_cumulative_clones: totalCumulativeClones,
    total_sum_of_daily_uniques: totalSumOfDailyUniques,
    methodology: {
      source: 'GitHub REST API GET /repos/{owner}/{repo}/traffic/clones?per=day',
      deduplication:
        'Keyed strictly by UTC date (YYYY-MM-DD); values within the 14-day rolling window are upserted and dates outside the window are retained permanently.',
      cumulative_clones_definition:
        'Exact sum of daily clone counts across all tracked UTC days. Includes git clones from developers, CI/CD runners, mirrors, and automated bots.',
      sum_of_daily_uniques_definition:
        'Sum of GitHub daily unique cloners across tracked UTC days. Trend reference only; NOT deduplicated across different days.',
      scope:
        'Public non-fork repositories by default (archive repository itself excluded by default). Archived public repositories remain tracked with archived=true; deleted, privatized, or no-longer-returned repositories remain preserved with active=false.',
      include_forks: Boolean(includeForks),
      excluded_repos: normalizedExcluded,
    },
    repos: repoEntries,
  };
}

/**
 * Compare two summary objects ignoring generated_at_utc to avoid noisy timestamp-only commits.
 */
export function hasSummaryChanged(prevSummary, nextSummary) {
  if (!prevSummary || typeof prevSummary !== 'object') return true;
  if (!nextSummary || typeof nextSummary !== 'object') return true;

  const { generated_at_utc: _prevTs, ...prevRest } = prevSummary;
  const { generated_at_utc: _nextTs, ...nextRest } = nextSummary;
  return !deepEqual(prevRest, nextRest);
}

/**
 * Format an integer count for Shields.io badges.
 * - 'exact': comma-separated integer (e.g. 1,284)
 * - 'compact': compact suffix (e.g. 1.2k, 3.4M)
 */
export function formatBadgeNumber(count, style = 'exact') {
  const n = toNonNegativeInt(count);
  const resolvedStyle = style || 'exact';

  if (resolvedStyle === 'exact') {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  if (resolvedStyle === 'compact') {
    if (n < 1_000) return String(n);
    if (n < 999_950) {
      return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    if (n < 999_950_000) {
      return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  }

  throw new RangeError(`Unsupported badge number style: ${JSON.stringify(style)}`);
}

/**
 * Build a Shields.io Endpoint schemaVersion: 1 JSON payload.
 */
export function buildBadgeJson({
  label,
  count,
  color = '0969da',
  numberStyle = 'exact',
} = {}) {
  return {
    schemaVersion: 1,
    label: String(label ?? 'clones'),
    message: formatBadgeNumber(count, numberStyle || 'exact'),
    color: String(color || '0969da'),
    cacheSeconds: 3600,
  };
}

/**
 * Render the Markdown statistics table inserted between TRAFFIC_TABLE markers in README.md.
 */
export function renderReadmeSection(
  summary,
  { owner = '', archiveRepo = '', branch = 'main' } = {},
) {
  const safeSummary = summary && typeof summary === 'object' ? summary : {};
  const repos = Array.isArray(safeSummary.repos) ? safeSummary.repos : [];
  const resolvedOwner = String(owner || safeSummary.owner || '').trim();
  const archiveFullName = resolveArchiveFullName(
    resolvedOwner,
    archiveRepo || safeSummary.archive_repo,
  );
  const safeBranch = String(branch || 'main').trim();

  const totalClones = formatBadgeNumber(safeSummary.total_cumulative_clones ?? 0, 'exact');
  const totalDailyUniques = formatBadgeNumber(
    safeSummary.total_sum_of_daily_uniques ?? 0,
    'exact',
  );
  const activeCount = toNonNegativeInt(safeSummary.active_public_repos ?? 0);
  const inactiveCount = toNonNegativeInt(safeSummary.historical_inactive_repos ?? 0);
  const trackingSince = safeSummary.tracking_since || '—';
  const generatedAt = safeSummary.generated_at_utc || '—';

  const lines = [
    `- **累计总克隆数（\`cumulative_clones\`）**：\`${totalClones}\``,
    `- **日独立克隆人数累加值（\`sum_of_daily_uniques\`，仅趋势参考）**：\`${totalDailyUniques}\``,
    `- **纳入统计仓库**：活跃公开仓 \`${activeCount}\` 个 / 历史保留仓 \`${inactiveCount}\` 个`,
    `- **统计起始日期（UTC）**：\`${trackingSince}\` ｜ **最近更新（UTC）**：\`${generatedAt}\``,
    '',
  ];

  if (repos.length === 0) {
    lines.push('_暂无已采集的公开仓数据。完成配置后请手动触发一次 `Collect Public Repo Clones` 工作流。_');
    return lines.join('\n');
  }

  lines.push(
    '| 仓库 | 状态 | 起始日期 (UTC) | 累计克隆数 | 日独立克隆累加* | 单仓徽章 |',
    '| --- | --- | :---: | ---: | ---: | :---: |',
  );

  for (const repo of repos) {
    const repoLabel = escapeMarkdownCell(repo.name || repo.repo);
    const safeUrl = sanitizeMarkdownUrl(repo.html_url);
    const repoCell = safeUrl ? `[${repoLabel}](${safeUrl})` : repoLabel;
    let statusCell = 'Active';
    if (!repo.active) {
      statusCell = 'Inactive (Preserved)';
    } else if (repo.archived) {
      statusCell = 'Active (Archived)';
    }

    const sinceCell = escapeMarkdownCell(repo.tracking_since || '—');
    const clonesCell = formatBadgeNumber(repo.cumulative_clones, 'exact');
    const uniquesCell = formatBadgeNumber(repo.sum_of_daily_uniques, 'exact');

    let badgeCell = '—';
    const canLinkBadge =
      archiveFullName &&
      repo.name &&
      repo.name.toLowerCase() !== 'total-clones';
    if (canLinkBadge) {
      const encodedBranch = safeBranch
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const badgeEndpoint = `https://raw.githubusercontent.com/${archiveFullName}/${encodedBranch}/badges/${encodeURIComponent(repo.name)}.json`;
      const badgeImg = `https://img.shields.io/endpoint?url=${badgeEndpoint}`;
      badgeCell = `![${repoLabel} clones](${badgeImg})`;
    }

    lines.push(
      `| ${repoCell} | ${statusCell} | ${sinceCell} | ${clonesCell} | ${uniquesCell} | ${badgeCell} |`,
    );
  }

  lines.push(
    '',
    '> \\* `sum_of_daily_uniques` 为各 UTC 自然日 `uniques` 之和，不可解释为跨日去重后的历史总人数；权威累积总数请以 `cumulative_clones` 为准。',
  );

  return lines.join('\n');
}

/**
 * Deterministically update content between TRAFFIC_TABLE markers using strict LF line endings.
 */
export function updateReadmeContent(existingReadme, sectionMarkdown) {
  const normalizedReadme = String(existingReadme ?? '').replace(/\r\n?/g, '\n');
  const normalizedSection = String(sectionMarkdown ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();

  const startIdx = normalizedReadme.indexOf(README_START_MARKER);
  const endIdx = normalizedReadme.indexOf(README_END_MARKER);

  if ((startIdx === -1) !== (endIdx === -1)) {
    throw new Error('Corrupted README markers: only one of START/END markers was found.');
  }
  if (startIdx !== -1 && endIdx < startIdx) {
    throw new Error('Corrupted README markers: END marker appears before START marker.');
  }

  const block = `${README_START_MARKER}\n${normalizedSection}\n${README_END_MARKER}`;

  if (startIdx === -1) {
    const trimmed = normalizedReadme.trimEnd();
    return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  }

  const before = normalizedReadme.slice(0, startIdx);
  const after = normalizedReadme.slice(endIdx + README_END_MARKER.length);
  const combined = `${before}${block}${after}`;
  return combined.endsWith('\n') ? combined : `${combined}\n`;
}
