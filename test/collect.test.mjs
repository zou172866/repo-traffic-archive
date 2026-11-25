import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import {
  README_END_MARKER,
  README_START_MARKER,
  buildBadgeJson,
  buildSummary,
  filterPublicRepos,
  formatBadgeNumber,
  hasSummaryChanged,
  markInactiveLedger,
  mergeDailyClones,
  renderReadmeSection,
  sanitizeRepoFileName,
  stableStringify,
  updateReadmeContent,
} from '../scripts/lib.mjs';
import { detectAuthMode, parseNextLink, runCollect } from '../scripts/collect.mjs';
import {
  buildCommitInput,
  commitVerifiedChanges,
  parseGitStatusPorcelainZ,
} from '../scripts/commit-verified.mjs';

function makeResponse(body, { status = 200, headers = {} } = {}) {
  const headerMap = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
  const textBody = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headerMap.get(String(name).toLowerCase()) ?? null;
      },
    },
    async json() {
      return JSON.parse(textBody);
    },
    async text() {
      return textBody;
    },
  };
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function assertLfOnly(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.equal(raw.includes('\r'), false, `Expected LF-only file without CR: ${filePath}`);
}

const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

describe('filterPublicRepos & sanitizeRepoFileName', () => {
  it('filters strictly to public repos, skips forks and excluded repos case-insensitively', () => {
    const repos = [
      {
        name: 'zeta',
        full_name: 'Alice/zeta',
        owner: { login: 'Alice' },
        private: false,
        visibility: 'public',
        fork: false,
      },
      {
        name: 'alpha',
        full_name: 'alice/alpha',
        owner: { login: 'alice' },
        private: false,
        visibility: 'public',
        fork: false,
      },
      {
        name: 'secret-repo',
        full_name: 'alice/secret-repo',
        owner: { login: 'alice' },
        private: true,
        visibility: 'private',
        fork: false,
      },
      {
        name: 'internal-repo',
        full_name: 'alice/internal-repo',
        owner: { login: 'alice' },
        private: false,
        visibility: 'internal',
        fork: false,
      },
      {
        name: 'forked-lib',
        full_name: 'alice/forked-lib',
        owner: { login: 'alice' },
        private: false,
        visibility: 'public',
        fork: true,
      },
      {
        name: 'repo-traffic-archive',
        full_name: 'alice/repo-traffic-archive',
        owner: { login: 'alice' },
        private: false,
        visibility: 'public',
        fork: false,
      },
      {
        name: 'skip-by-fullname',
        full_name: 'alice/skip-by-fullname',
        owner: { login: 'alice' },
        private: false,
        visibility: 'public',
        fork: false,
      },
      {
        name: 'other-owner-repo',
        full_name: 'bob/other-owner-repo',
        owner: { login: 'bob' },
        private: false,
        visibility: 'public',
        fork: false,
      },
    ];

    const filtered = filterPublicRepos(repos, {
      owner: 'ALICE',
      includeForks: false,
      excludeRepos: ['REPO-TRAFFIC-ARCHIVE', 'Alice/Skip-By-Fullname'],
    });
    assert.deepEqual(
      filtered.map((r) => r.name),
      ['alpha', 'zeta'],
    );

    const withForks = filterPublicRepos(repos, {
      owner: 'alice',
      includeForks: true,
      excludeRepos: ['repo-traffic-archive', 'alice/skip-by-fullname'],
    });
    assert.deepEqual(
      withForks.map((r) => r.name),
      ['alpha', 'forked-lib', 'zeta'],
    );
  });

  it('validates safe filenames and blocks path traversal or reserved names', () => {
    assert.equal(sanitizeRepoFileName('.github'), '.github');
    assert.equal(sanitizeRepoFileName('my-repo_1.2'), 'my-repo_1.2');

    for (const bad of ['', '.', '..', '../evil', 'a/b', 'a\\b', 'foo..bar', 'foo.', 'CON', 'nul', 'has space']) {
      assert.throws(() => sanitizeRepoFileName(bad), /Unsafe|non-empty/);
    }
  });
});

describe('mergeDailyClones & markInactiveLedger', () => {
  it('merges overlapping 14-day windows idempotently, updates partial UTC day, and preserves >14-day history', () => {
    // Initial run covering 2026-02-01 and 2026-02-02 (partial UTC day)
    const run1 = mergeDailyClones(
      null,
      [
        { timestamp: '2026-02-02T00:00:00Z', count: 3, uniques: 2 },
        { timestamp: '2026-02-01T00:00:00Z', count: 10, uniques: 5 },
      ],
      {
        repoFullName: 'alice/demo',
        repoMeta: { name: 'demo', html_url: 'https://github.com/alice/demo', archived: false },
        fetchedAtUtc: '2026-02-02T12:00:00.000Z',
      },
    );

    assert.equal(run1.dataChanged, true);
    assert.deepEqual(Object.keys(run1.ledger.days), ['2026-02-01', '2026-02-02']);
    assert.equal(run1.ledger.cumulative_clones, 13);
    assert.equal(run1.ledger.sum_of_daily_uniques, 7);
    assert.equal(run1.ledger.tracking_since, '2026-02-01');

    // Exact re-fetch of overlapping window => no double counting, dataChanged === false
    const run2 = mergeDailyClones(
      run1.ledger,
      [
        { timestamp: '2026-02-01T00:00:00Z', count: 10, uniques: 5 },
        { timestamp: '2026-02-02T00:00:00Z', count: 3, uniques: 2 },
      ],
      {
        repoFullName: 'alice/demo',
        repoMeta: { name: 'demo', html_url: 'https://github.com/alice/demo', archived: false },
        fetchedAtUtc: '2026-02-02T18:00:00.000Z',
      },
    );

    assert.equal(run2.dataChanged, false);
    assert.equal(run2.ledger.cumulative_clones, 13);
    assert.equal(run2.ledger.last_updated_utc, '2026-02-02T12:00:00.000Z');

    // Partial UTC day grows upward + new day outside original 14-day window
    const run3 = mergeDailyClones(
      run2.ledger,
      [
        { timestamp: '2026-02-02T00:00:00Z', count: 8, uniques: 4 },
        { timestamp: '2026-02-20T00:00:00Z', count: 6, uniques: 3 },
      ],
      {
        repoFullName: 'alice/demo',
        repoMeta: { name: 'demo', html_url: 'https://github.com/alice/demo', archived: false },
        fetchedAtUtc: '2026-02-21T02:15:00.000Z',
      },
    );

    assert.equal(run3.dataChanged, true);
    assert.deepEqual(Object.keys(run3.ledger.days), ['2026-02-01', '2026-02-02', '2026-02-20']);
    assert.equal(run3.ledger.days['2026-02-01'].count, 10); // >14-day historical day preserved
    assert.equal(run3.ledger.days['2026-02-02'].count, 8); // partial day updated to latest
    assert.equal(run3.ledger.cumulative_clones, 24);
    assert.equal(run3.ledger.sum_of_daily_uniques, 12);

    // Empty API array preserves all historical days safely without noisy diff
    const run4 = mergeDailyClones(run3.ledger, [], {
      repoFullName: 'alice/demo',
      repoMeta: { name: 'demo', html_url: 'https://github.com/alice/demo', archived: false },
      fetchedAtUtc: '2026-03-10T02:15:00.000Z',
    });

    assert.equal(run4.dataChanged, false);
    assert.equal(run4.ledger.cumulative_clones, 24);
    assert.deepEqual(Object.keys(run4.ledger.days), ['2026-02-01', '2026-02-02', '2026-02-20']);
  });

  it('preserves historical counts when marking a ledger inactive and stays idempotent', () => {
    const initial = mergeDailyClones(
      null,
      [{ timestamp: '2026-01-10T00:00:00Z', count: 42, uniques: 19 }],
      {
        repoFullName: 'alice/legacy',
        fetchedAtUtc: '2026-01-11T02:15:00.000Z',
      },
    ).ledger;

    const inactive1 = markInactiveLedger(initial, {
      fetchedAtUtc: '2026-02-01T02:15:00.000Z',
    });
    assert.equal(inactive1.dataChanged, true);
    assert.equal(inactive1.ledger.active, false);
    assert.equal(inactive1.ledger.cumulative_clones, 42);
    assert.equal(inactive1.ledger.sum_of_daily_uniques, 19);
    assert.equal(inactive1.ledger.last_seen_missing_utc, '2026-02-01T02:15:00.000Z');
    assert.deepEqual(inactive1.ledger.days, { '2026-01-10': { count: 42, uniques: 19 } });

    const inactive2 = markInactiveLedger(inactive1.ledger, {
      fetchedAtUtc: '2026-02-02T02:15:00.000Z',
    });
    assert.equal(inactive2.dataChanged, false);
    assert.equal(inactive2.ledger.last_seen_missing_utc, '2026-02-01T02:15:00.000Z');

    // If repo returns later, active becomes true and last_seen_missing_utc is cleared
    const revived = mergeDailyClones(inactive2.ledger, [], {
      repoFullName: 'alice/legacy',
      fetchedAtUtc: '2026-02-03T02:15:00.000Z',
    });
    assert.equal(revived.dataChanged, true);
    assert.equal(revived.ledger.active, true);
    assert.equal('last_seen_missing_utc' in revived.ledger, false);
    assert.equal(revived.ledger.cumulative_clones, 42);
  });
});

describe('buildSummary, hasSummaryChanged, badges & README rendering', () => {
  it('computes summary totals, deterministic ordering, and ignores generated_at_utc in hasSummaryChanged', () => {
    const ledgerA = mergeDailyClones(
      null,
      [{ timestamp: '2026-02-05T00:00:00Z', count: 50, uniques: 20 }],
      { repoFullName: 'alice/bravo', fetchedAtUtc: '2026-02-06T02:15:00.000Z' },
    ).ledger;
    const ledgerB = mergeDailyClones(
      null,
      [{ timestamp: '2026-02-01T00:00:00Z', count: 50, uniques: 10 }],
      { repoFullName: 'alice/alpha', fetchedAtUtc: '2026-02-06T02:15:00.000Z' },
    ).ledger;
    const ledgerC = markInactiveLedger(
      mergeDailyClones(
        null,
        [{ timestamp: '2026-01-15T00:00:00Z', count: 120, uniques: 40 }],
        { repoFullName: 'alice/old-hit', fetchedAtUtc: '2026-01-20T02:15:00.000Z' },
      ).ledger,
      { fetchedAtUtc: '2026-02-06T02:15:00.000Z' },
    ).ledger;

    const s1 = buildSummary([ledgerA, ledgerB, ledgerC], {
      owner: 'alice',
      archiveRepo: 'alice/repo-traffic-archive',
      generatedAtUtc: '2026-02-06T02:15:00.000Z',
      includeForks: false,
      excludeRepos: ['repo-traffic-archive'],
    });

    assert.equal(s1.total_cumulative_clones, 220);
    assert.equal(s1.total_sum_of_daily_uniques, 70);
    assert.equal(s1.active_public_repos, 2);
    assert.equal(s1.historical_inactive_repos, 1);
    assert.equal(s1.tracking_since, '2026-01-15');
    assert.deepEqual(
      s1.repos.map((r) => r.name),
      ['old-hit', 'alpha', 'bravo'],
    );

    const s2 = buildSummary([ledgerB, ledgerC, ledgerA], {
      owner: 'alice',
      archiveRepo: 'alice/repo-traffic-archive',
      generatedAtUtc: '2026-02-07T02:15:00.000Z',
      includeForks: false,
      excludeRepos: ['repo-traffic-archive'],
    });
    assert.equal(hasSummaryChanged(s1, s2), false);

    const s3 = { ...s2, total_cumulative_clones: 221 };
    assert.equal(hasSummaryChanged(s1, s3), true);
  });

  it('formats exact & compact badge numbers and builds valid Shields.io schemaVersion 1 JSON', () => {
    assert.equal(formatBadgeNumber(0, 'exact'), '0');
    assert.equal(formatBadgeNumber(1284, 'exact'), '1,284');
    assert.equal(formatBadgeNumber(1234567, 'exact'), '1,234,567');

    assert.equal(formatBadgeNumber(999, 'compact'), '999');
    assert.equal(formatBadgeNumber(1000, 'compact'), '1k');
    assert.equal(formatBadgeNumber(1200, 'compact'), '1.2k');
    assert.equal(formatBadgeNumber(999950, 'compact'), '1M');
    assert.equal(formatBadgeNumber(3400000, 'compact'), '3.4M');
    assert.equal(formatBadgeNumber(1200000000, 'compact'), '1.2B');

    assert.throws(() => formatBadgeNumber(10, 'invalid'), RangeError);

    assert.deepEqual(
      buildBadgeJson({ label: 'total clones', count: 1284, color: '0969da', numberStyle: 'exact' }),
      {
        schemaVersion: 1,
        label: 'total clones',
        message: '1,284',
        color: '0969da',
        cacheSeconds: 3600,
      },
    );
  });

  it('updates README markers idempotently with strict LF line endings', () => {
    const summary = buildSummary(
      [
        mergeDailyClones(
          null,
          [{ timestamp: '2026-03-01T00:00:00Z', count: 1284, uniques: 321 }],
          { repoFullName: 'alice/demo', fetchedAtUtc: '2026-03-02T02:15:00.000Z' },
        ).ledger,
      ],
      {
        owner: 'alice',
        archiveRepo: 'repo-traffic-archive',
        generatedAtUtc: '2026-03-02T02:15:00.000Z',
      },
    );

    const section = renderReadmeSection(summary, {
      owner: 'alice',
      archiveRepo: 'repo-traffic-archive',
      branch: 'main',
    });
    assert.ok(section.includes('1,284'));
    assert.ok(
      section.includes(
        'https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/alice/repo-traffic-archive/main/badges/demo.json',
      ),
    );

    const crlfReadme = `# Title\r\n\r\n${README_START_MARKER}\r\nold\r\n${README_END_MARKER}\r\n\r\nFooter\r\n`;
    const updated1 = updateReadmeContent(crlfReadme, section);
    assert.equal(updated1.includes('\r'), false);
    assert.ok(updated1.startsWith('# Title\n\n'));
    assert.ok(updated1.endsWith('\n\nFooter\n'));

    const updated2 = updateReadmeContent(updated1, section);
    assert.equal(updated2, updated1);

    assert.throws(
      () => updateReadmeContent(`${README_END_MARKER}\n${README_START_MARKER}`, section),
      /Corrupted README markers/,
    );
  });
});

describe('commit-verified.mjs builders & git integration', () => {
  it('parses git status --porcelain=v1 -z output including additions, deletions, renames, and copies', () => {
    const porcelain = [
      ' M README.md',
      '?? data/summary.json',
      '?? badges/demo.json',
      ' D data/daily/removed.json',
      'R  data/daily/new-name.json',
      'data/daily/old-name.json',
      'AD badges/transient.json',
      '',
    ].join('\0');

    const parsed = parseGitStatusPorcelainZ(porcelain);
    assert.deepEqual(parsed.additionPaths, [
      'README.md',
      'badges/demo.json',
      'data/daily/new-name.json',
      'data/summary.json',
    ]);
    assert.deepEqual(parsed.deletionPaths, [
      'data/daily/old-name.json',
      'data/daily/removed.json',
    ]);
  });

  it('builds GraphQL createCommitOnBranch input cleanly and omits empty deletion/addition lists', () => {
    const input = buildCommitInput({
      repoWithOwner: 'alice/repo-traffic-archive',
      branchName: 'refs/heads/main',
      headOid: 'a'.repeat(40),
      headline: 'chore(traffic): update clone archive',
      additions: [{ path: 'data/summary.json', contents: Buffer.from('{"ok":true}\n', 'utf8') }],
      deletions: [],
    });

    assert.equal(input.branch.repositoryNameWithOwner, 'alice/repo-traffic-archive');
    assert.equal(input.branch.branchName, 'main');
    assert.equal(input.expectedHeadOid, 'a'.repeat(40));
    assert.deepEqual(input.fileChanges, {
      additions: [
        {
          path: 'data/summary.json',
          contents: Buffer.from('{"ok":true}\n', 'utf8').toString('base64'),
        },
      ],
    });
    assert.equal('deletions' in input.fileChanges, false);
  });

  it('commits untracked nested files and deletions via mocked GraphQL API and handles clean tree', async () => {
    const repoDir = makeTempDir('traffic-git-test-');
    const ghOutput = path.join(repoDir, 'github_output.txt');
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test Bot'], { cwd: repoDir });

      fs.mkdirSync(path.join(repoDir, 'data', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# Archive\n', 'utf8');
      fs.writeFileSync(path.join(repoDir, 'data', 'daily', 'old.json'), '{}\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
      const headOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

      // 1. Clean working tree => changed=false, no network call
      let calls = 0;
      const cleanRes = await commitVerifiedChanges({
        cwd: repoDir,
        token: 'ghs_fake',
        repoWithOwner: 'alice/repo-traffic-archive',
        branchName: 'main',
        githubOutputPath: ghOutput,
        fetchImpl: async () => {
          calls += 1;
          throw new Error('Should not be called on clean working tree');
        },
        logger: silentLogger,
      });
      assert.equal(cleanRes.changed, false);
      assert.equal(calls, 0);
      assert.ok(fs.readFileSync(ghOutput, 'utf8').includes('changed=false'));

      // 2. Dirty working tree: untracked nested dirs + modified README + deleted tracked file
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# Archive Updated\n', 'utf8');
      fs.unlinkSync(path.join(repoDir, 'data', 'daily', 'old.json'));
      fs.mkdirSync(path.join(repoDir, 'badges'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'data', 'summary.json'), '{"total":1}\n', 'utf8');
      fs.writeFileSync(path.join(repoDir, 'badges', 'total-clones.json'), '{"schemaVersion":1}\n', 'utf8');

      let capturedRequest = null;
      const dirtyRes = await commitVerifiedChanges({
        cwd: repoDir,
        token: 'ghs_fake',
        repoWithOwner: 'alice/repo-traffic-archive',
        branchName: 'main',
        githubOutputPath: ghOutput,
        nowUtc: '2026-03-15T02:15:00.000Z',
        fetchImpl: async (url, init) => {
          capturedRequest = { url, body: JSON.parse(init.body) };
          return makeResponse({
            data: {
              createCommitOnBranch: {
                commit: {
                  oid: 'b'.repeat(40),
                  url: 'https://github.com/alice/repo-traffic-archive/commit/' + 'b'.repeat(40),
                },
              },
            },
          });
        },
        logger: silentLogger,
      });

      assert.equal(dirtyRes.changed, true);
      assert.equal(dirtyRes.commitSha, 'b'.repeat(40));
      assert.equal(capturedRequest.body.variables.input.expectedHeadOid, headOid);
      assert.deepEqual(
        capturedRequest.body.variables.input.fileChanges.additions.map((a) => a.path),
        ['README.md', 'badges/total-clones.json', 'data/summary.json'],
      );
      assert.deepEqual(capturedRequest.body.variables.input.fileChanges.deletions, [
        { path: 'data/daily/old.json' },
      ]);

      const outputText = fs.readFileSync(ghOutput, 'utf8');
      assert.ok(outputText.includes('changed=true'));
      assert.ok(outputText.includes(`commit_sha=${'b'.repeat(40)}`));

      // 3. GraphQL errors fail loudly
      await assert.rejects(
        () =>
          commitVerifiedChanges({
            cwd: repoDir,
            token: 'ghs_fake',
            repoWithOwner: 'alice/repo-traffic-archive',
            branchName: 'main',
            fetchImpl: async () =>
              makeResponse({
                errors: [{ message: 'Expected branch to point to newer OID' }],
              }),
            logger: silentLogger,
          }),
        /Expected branch to point to newer OID/,
      );

      // 4. Non-2xx HTTP errors fail loudly
      await assert.rejects(
        () =>
          commitVerifiedChanges({
            cwd: repoDir,
            token: 'ghs_fake',
            repoWithOwner: 'alice/repo-traffic-archive',
            branchName: 'main',
            fetchImpl: async () => makeResponse('Internal Server Error', { status: 500 }),
            logger: silentLogger,
          }),
        /GitHub GraphQL HTTP 500/,
      );
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('collect.mjs helpers & end-to-end mocked runCollect', () => {
  it('parses Link next header and auto-detects auth mode', () => {
    assert.equal(
      parseNextLink(
        '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next", <https://api.github.com/installation/repositories?per_page=100&page=5>; rel="last"',
      ),
      'https://api.github.com/installation/repositories?per_page=100&page=2',
    );
    assert.equal(parseNextLink('<https://api.github.com/foo?page=1>; rel="prev"'), null);
    assert.equal(detectAuthMode('ghs_abc123', 'auto'), 'app');
    assert.equal(detectAuthMode('github_pat_xyz', 'auto'), 'pat');
    assert.equal(detectAuthMode('github_pat_xyz', 'app'), 'app');
  });

  it('executes full end-to-end collection with pagination, retries, 403 skip, no-op repeat, heartbeat, and inactive retention', async () => {
    const tmpDir = makeTempDir('traffic-collect-e2e-');
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'README.md'),
        `# Demo Archive\n\n${README_START_MARKER}\nplaceholder\n${README_END_MARKER}\n`,
        'utf8',
      );

      let betaAttempts = 0;
      let includeBetaInApi = true;
      let alphaClones = [
        { timestamp: '2026-03-01T00:00:00Z', count: 100, uniques: 40 },
        { timestamp: '2026-03-02T00:00:00Z', count: 25, uniques: 10 },
      ];

      const mockFetch = async (url) => {
        if (url === 'https://api.github.com/installation/repositories?per_page=100') {
          return makeResponse(
            {
              total_count: 5,
              repositories: [
                {
                  name: 'alpha',
                  full_name: 'alice/alpha',
                  owner: { login: 'alice' },
                  html_url: 'https://github.com/alice/alpha',
                  private: false,
                  visibility: 'public',
                  fork: false,
                  archived: false,
                },
                {
                  name: 'repo-traffic-archive',
                  full_name: 'alice/repo-traffic-archive',
                  owner: { login: 'alice' },
                  html_url: 'https://github.com/alice/repo-traffic-archive',
                  private: false,
                  visibility: 'public',
                  fork: false,
                  archived: false,
                },
                {
                  name: 'private-secret',
                  full_name: 'alice/private-secret',
                  owner: { login: 'alice' },
                  html_url: 'https://github.com/alice/private-secret',
                  private: true,
                  visibility: 'private',
                  fork: false,
                  archived: false,
                },
              ],
            },
            {
              headers: {
                link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
              },
            },
          );
        }

        if (url === 'https://api.github.com/installation/repositories?per_page=100&page=2') {
          const page2 = [
            {
              name: 'forbidden-repo',
              full_name: 'alice/forbidden-repo',
              owner: { login: 'alice' },
              html_url: 'https://github.com/alice/forbidden-repo',
              private: false,
              visibility: 'public',
              fork: false,
              archived: false,
            },
            {
              name: 'total-clones',
              full_name: 'alice/total-clones',
              owner: { login: 'alice' },
              html_url: 'https://github.com/alice/total-clones',
              private: false,
              visibility: 'public',
              fork: false,
              archived: false,
            },
          ];
          if (includeBetaInApi) {
            page2.unshift({
              name: 'beta',
              full_name: 'alice/beta',
              owner: { login: 'alice' },
              html_url: 'https://github.com/alice/beta',
              private: false,
              visibility: 'public',
              fork: false,
              archived: false,
            });
          }
          return makeResponse({ total_count: 5, repositories: page2 });
        }

        if (url === 'https://api.github.com/repos/alice/alpha/traffic/clones?per=day') {
          return makeResponse({ count: 9999, uniques: 9999, clones: alphaClones });
        }

        if (url === 'https://api.github.com/repos/alice/beta/traffic/clones?per=day') {
          betaAttempts += 1;
          if (betaAttempts === 1) {
            return makeResponse({ message: 'Transient outage' }, { status: 503 });
          }
          return makeResponse({
            count: 15,
            uniques: 7,
            clones: [{ timestamp: '2026-03-01T00:00:00Z', count: 15, uniques: 7 }],
          });
        }

        if (url === 'https://api.github.com/repos/alice/forbidden-repo/traffic/clones?per=day') {
          return makeResponse({ message: 'Must have push access' }, { status: 403 });
        }

        if (url === 'https://api.github.com/repos/alice/total-clones/traffic/clones?per=day') {
          return makeResponse({
            count: 5,
            uniques: 2,
            clones: [{ timestamp: '2026-03-02T00:00:00Z', count: 5, uniques: 2 }],
          });
        }

        throw new Error(`Unexpected URL in mockFetch: ${url}`);
      };

      // Run 1: initial collection
      const res1 = await runCollect({
        rootDir: tmpDir,
        token: 'ghs_test_app_token',
        owner: 'alice',
        archiveRepo: 'alice/repo-traffic-archive',
        fetchedAtUtc: '2026-03-02T02:15:00.000Z',
        fetchImpl: mockFetch,
        retryDelayMs: 0,
        logger: silentLogger,
      });

      assert.equal(res1.mode, 'app');
      assert.equal(betaAttempts, 2); // retried once after 503
      assert.equal(res1.skippedRepos.length, 1);
      assert.equal(res1.skippedRepos[0].repo, 'alice/forbidden-repo');
      assert.equal(res1.summary.total_cumulative_clones, 145); // 125 (alpha) + 15 (beta) + 5 (total-clones), NOT top-level 9999
      assert.equal(res1.summary.total_sum_of_daily_uniques, 59);
      assert.equal(res1.summary.active_public_repos, 3);
      assert.equal(fs.existsSync(path.join(tmpDir, 'data', 'daily', 'repo-traffic-archive.json')), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'data', 'daily', 'private-secret.json')), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'data', 'daily', 'forbidden-repo.json')), false);

      // Account total badge was NOT overwritten by repo named "total-clones"
      const totalBadge = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'badges', 'total-clones.json'), 'utf8'),
      );
      assert.equal(totalBadge.label, 'total clones');
      assert.equal(totalBadge.message, '145');

      const alphaBadge = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'badges', 'alpha.json'), 'utf8'),
      );
      assert.equal(alphaBadge.message, '125');

      for (const relPath of [
        'data/summary.json',
        'data/daily/alpha.json',
        'data/daily/beta.json',
        'badges/total-clones.json',
        'badges/alpha.json',
        'badges/beta.json',
        'README.md',
      ]) {
        assertLfOnly(path.join(tmpDir, relPath));
      }

      // Run 2: identical counts without heartbeat => 0 files written!
      const res2 = await runCollect({
        rootDir: tmpDir,
        token: 'ghs_test_app_token',
        owner: 'alice',
        archiveRepo: 'alice/repo-traffic-archive',
        fetchedAtUtc: '2026-03-03T02:15:00.000Z',
        heartbeatCommit: false,
        fetchImpl: mockFetch,
        retryDelayMs: 0,
        logger: silentLogger,
      });
      assert.deepEqual(res2.filesWritten, []);

      // Run 3: identical counts WITH heartbeat => summary.json and README.md updated with new timestamp
      const res3 = await runCollect({
        rootDir: tmpDir,
        token: 'ghs_test_app_token',
        owner: 'alice',
        archiveRepo: 'alice/repo-traffic-archive',
        fetchedAtUtc: '2026-03-04T02:15:00.000Z',
        heartbeatCommit: true,
        fetchImpl: mockFetch,
        retryDelayMs: 0,
        logger: silentLogger,
      });
      assert.deepEqual(res3.filesWritten.sort(), ['README.md', 'data/summary.json']);
      assert.equal(res3.summary.generated_at_utc, '2026-03-04T02:15:00.000Z');

      // Run 4: beta disappears (deleted/privatized) => preserved as active=false, total stays 145!
      includeBetaInApi = false;
      const res4 = await runCollect({
        rootDir: tmpDir,
        token: 'ghs_test_app_token',
        owner: 'alice',
        archiveRepo: 'alice/repo-traffic-archive',
        fetchedAtUtc: '2026-03-05T02:15:00.000Z',
        fetchImpl: mockFetch,
        retryDelayMs: 0,
        logger: silentLogger,
      });

      assert.equal(res4.summary.total_cumulative_clones, 145);
      assert.equal(res4.summary.active_public_repos, 2);
      assert.equal(res4.summary.historical_inactive_repos, 1);
      const betaLedger = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'data', 'daily', 'beta.json'), 'utf8'),
      );
      assert.equal(betaLedger.active, false);
      assert.equal(betaLedger.cumulative_clones, 15);
      assert.equal(betaLedger.last_seen_missing_utc, '2026-03-05T02:15:00.000Z');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('supports PAT fallback for both Organization and User accounts', async () => {
    const orgDir = makeTempDir('traffic-pat-org-');
    const userDir = makeTempDir('traffic-pat-user-');
    try {
      const orgUrls = [];
      const orgFetch = async (url) => {
        orgUrls.push(url);
        if (url === 'https://api.github.com/users/acme-org') {
          return makeResponse({ login: 'acme-org', type: 'Organization' });
        }
        if (url === 'https://api.github.com/orgs/acme-org/repos?type=public&per_page=100') {
          return makeResponse([
            {
              name: 'sdk',
              full_name: 'acme-org/sdk',
              owner: { login: 'acme-org' },
              html_url: 'https://github.com/acme-org/sdk',
              private: false,
              visibility: 'public',
              fork: false,
              archived: false,
            },
          ]);
        }
        if (url === 'https://api.github.com/repos/acme-org/sdk/traffic/clones?per=day') {
          return makeResponse({
            count: 7,
            uniques: 3,
            clones: [{ timestamp: '2026-03-10T00:00:00Z', count: 7, uniques: 3 }],
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const orgRes = await runCollect({
        rootDir: orgDir,
        token: 'github_pat_example',
        owner: 'acme-org',
        archiveRepo: 'acme-org/repo-traffic-archive',
        fetchedAtUtc: '2026-03-11T02:15:00.000Z',
        fetchImpl: orgFetch,
        retryDelayMs: 0,
        logger: silentLogger,
      });

      assert.equal(orgRes.mode, 'pat');
      assert.equal(orgRes.summary.total_cumulative_clones, 7);
      assert.ok(orgUrls.includes('https://api.github.com/orgs/acme-org/repos?type=public&per_page=100'));

      const userUrls = [];
      const userFetch = async (url) => {
        userUrls.push(url);
        if (url === 'https://api.github.com/users/bob') {
          return makeResponse({ login: 'bob', type: 'User' });
        }
        if (url === 'https://api.github.com/users/bob/repos?type=owner&per_page=100') {
          return makeResponse([
            {
              name: 'cli-tool',
              full_name: 'bob/cli-tool',
              owner: { login: 'bob' },
              html_url: 'https://github.com/bob/cli-tool',
              private: false,
              visibility: 'public',
              fork: false,
              archived: false,
            },
          ]);
        }
        if (url === 'https://api.github.com/repos/bob/cli-tool/traffic/clones?per=day') {
          return makeResponse({
            count: 11,
            uniques: 4,
            clones: [{ timestamp: '2026-03-10T00:00:00Z', count: 11, uniques: 4 }],
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const userRes = await runCollect({
        rootDir: userDir,
        token: 'github_pat_example',
        owner: 'bob',
        archiveRepo: 'bob/repo-traffic-archive',
        fetchedAtUtc: '2026-03-11T02:15:00.000Z',
        fetchImpl: userFetch,
        retryDelayMs: 0,
        logger: silentLogger,
      });

      assert.equal(userRes.mode, 'pat');
      assert.equal(userRes.summary.total_cumulative_clones, 11);
      assert.ok(userUrls.includes('https://api.github.com/users/bob/repos?type=owner&per_page=100'));
    } finally {
      fs.rmSync(orgDir, { recursive: true, force: true });
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });

  it('handles zero public repos cleanly and preserves existing ledger when traffic endpoint later returns 403', async () => {
    const emptyDir = makeTempDir('traffic-empty-');
    const keepDir = makeTempDir('traffic-keep403-');
    try {
      // 0 public repos
      const emptyRes = await runCollect({
        rootDir: emptyDir,
        token: 'ghs_empty',
        owner: 'nobody',
        archiveRepo: 'nobody/repo-traffic-archive',
        fetchedAtUtc: '2026-03-12T02:15:00.000Z',
        fetchImpl: async () => makeResponse({ total_count: 0, repositories: [] }),
        retryDelayMs: 0,
        logger: silentLogger,
      });
      assert.equal(emptyRes.summary.total_cumulative_clones, 0);
      assert.equal(emptyRes.summary.repos.length, 0);
      assert.equal(fs.existsSync(path.join(emptyDir, 'data', 'summary.json')), true);
      assert.equal(fs.existsSync(path.join(emptyDir, 'badges', 'total-clones.json')), true);
      assertLfOnly(path.join(emptyDir, 'data', 'summary.json'));
      assertLfOnly(path.join(emptyDir, 'README.md'));

      // Existing ledger preserved on subsequent 403
      fs.mkdirSync(path.join(keepDir, 'data', 'daily'), { recursive: true });
      const seededLedger = mergeDailyClones(
        null,
        [{ timestamp: '2026-03-01T00:00:00Z', count: 88, uniques: 22 }],
        { repoFullName: 'alice/existing', fetchedAtUtc: '2026-03-02T02:15:00.000Z' },
      ).ledger;
      fs.writeFileSync(
        path.join(keepDir, 'data', 'daily', 'existing.json'),
        stableStringify(seededLedger),
        'utf8',
      );

      const res403 = await runCollect({
        rootDir: keepDir,
        token: 'ghs_test',
        owner: 'alice',
        archiveRepo: 'alice/repo-traffic-archive',
        fetchedAtUtc: '2026-03-12T02:15:00.000Z',
        fetchImpl: async (url) => {
          if (url.includes('/installation/repositories')) {
            return makeResponse({
              total_count: 1,
              repositories: [
                {
                  name: 'existing',
                  full_name: 'alice/existing',
                  owner: { login: 'alice' },
                  html_url: 'https://github.com/alice/existing',
                  private: false,
                  visibility: 'public',
                  fork: false,
                  archived: false,
                },
              ],
            });
          }
          return makeResponse({ message: 'Forbidden' }, { status: 403 });
        },
        retryDelayMs: 0,
        logger: silentLogger,
      });

      assert.equal(res403.skippedRepos.length, 1);
      assert.equal(res403.summary.total_cumulative_clones, 88);
      assert.equal(res403.summary.active_public_repos, 1);
      assert.equal(res403.summary.historical_inactive_repos, 0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
      fs.rmSync(keepDir, { recursive: true, force: true });
    }
  });

  it('refuses cross-origin pagination links to prevent token leakage', async () => {
    const tmpDir = makeTempDir('traffic-origin-');
    try {
      await assert.rejects(
        () =>
          runCollect({
            rootDir: tmpDir,
            token: 'ghs_secret',
            owner: 'alice',
            archiveRepo: 'alice/repo-traffic-archive',
            fetchImpl: async () =>
              makeResponse(
                { total_count: 1, repositories: [] },
                {
                  headers: {
                    link: '<https://evil.example.com/steal?page=2>; rel="next"',
                  },
                },
              ),
            retryDelayMs: 0,
            logger: silentLogger,
          }),
        /cross-origin pagination link/i,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('produces deterministic LF JSON via stableStringify', () => {
    const json = stableStringify({ a: 1, b: [2, 3] });
    assert.equal(json, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
    assert.equal(json.includes('\r'), false);
  });
});

describe('adversarial edge-case & regression coverage', () => {
  it('blocks Windows reserved device names with extensions, rejects visibility:null, and deduplicates repos', () => {
    for (const bad of ['con.js', 'nul.repo', 'AUX.1', 'com1.json', 'lpt9.test']) {
      assert.throws(() => sanitizeRepoFileName(bad), /Unsafe/);
    }
    assert.equal(sanitizeRepoFileName('console'), 'console');
    assert.equal(sanitizeRepoFileName('my-con'), 'my-con');

    const repos = [
      { name: 'null-vis', full_name: 'alice/null-vis', owner: { login: 'alice' }, private: false, visibility: null },
      { name: 'empty-vis', full_name: 'alice/empty-vis', owner: { login: 'alice' }, private: false, visibility: '' },
      { name: 'dup', full_name: 'alice/dup', owner: { login: 'alice' }, private: false, visibility: 'public' },
      { name: 'dup', full_name: 'Alice/DUP', owner: { login: 'Alice' }, private: false, visibility: 'public' },
    ];
    const filtered = filterPublicRepos(repos, { owner: 'alice' });
    assert.deepEqual(
      filtered.map((r) => r.name),
      ['dup'],
    );
  });

  it('validates calendar dates, normalizes non-UTC ISO timestamps to UTC, and syncs name on case-only rename', () => {
    const merged = mergeDailyClones(
      null,
      [
        { timestamp: '2026-02-31T00:00:00Z', count: 99, uniques: 9 },
        { timestamp: '2026-13-01T00:00:00Z', count: 88, uniques: 8 },
        { timestamp: '2026-03-01T23:30:00-05:00', count: 7, uniques: 3 },
      ],
      { repoFullName: 'alice/MyRepo', fetchedAtUtc: '2026-03-02T02:15:00.000Z' },
    );
    assert.deepEqual(merged.ledger.days, {
      '2026-03-02': { count: 7, uniques: 3 },
    });
    assert.equal(merged.ledger.cumulative_clones, 7);

    const renamed = mergeDailyClones(merged.ledger, [], {
      repoFullName: 'alice/myrepo',
      fetchedAtUtc: '2026-03-03T02:15:00.000Z',
    });
    assert.equal(renamed.dataChanged, true);
    assert.equal(renamed.ledger.repo, 'alice/myrepo');
    assert.equal(renamed.ledger.name, 'myrepo');
  });

  it('encodes multi-segment branch names and sanitizes unsafe URLs/newlines in README rendering', () => {
    const summary = buildSummary(
      [
        mergeDailyClones(
          null,
          [{ timestamp: '2026-03-01T00:00:00Z', count: 12, uniques: 4 }],
          {
            repoFullName: 'alice/demo',
            repoMeta: { name: 'demo', html_url: 'javascript:alert(1)' },
            fetchedAtUtc: '2026-03-02T02:15:00.000Z',
          },
        ).ledger,
      ],
      {
        owner: 'alice',
        archiveRepo: 'alice/archive',
        generatedAtUtc: '2026-03-02T02:15:00.000Z',
      },
    );
    const md = renderReadmeSection(summary, {
      owner: 'alice',
      archiveRepo: 'alice/archive',
      branch: 'release/v1',
    });
    assert.equal(md.includes('javascript:'), false);
    assert.ok(
      md.includes(
        'https://raw.githubusercontent.com/alice/archive/release/v1/badges/demo.json',
      ),
    );
  });

  it('parses RFC 8288 Link headers with extra params/unquoted rel and blocks protocol-relative cross-origin links', async () => {
    assert.equal(
      parseNextLink('<https://api.github.com/x?page=2>; title="next page"; rel="next"'),
      'https://api.github.com/x?page=2',
    );
    assert.equal(
      parseNextLink('<https://api.github.com/x?page=3>; rel=next'),
      'https://api.github.com/x?page=3',
    );

    const tmpDir = makeTempDir('traffic-rel-link-');
    try {
      // Relative same-origin Link works
      const relRes = await runCollect({
        rootDir: tmpDir,
        token: 'ghs_rel',
        owner: 'alice',
        archiveRepo: 'alice/archive',
        retryDelayMs: 0,
        logger: silentLogger,
        fetchImpl: async (url) => {
          if (url === 'https://api.github.com/installation/repositories?per_page=100') {
            return makeResponse(
              { repositories: [] },
              { headers: { link: '</installation/repositories?per_page=100&page=2>; rel=next' } },
            );
          }
          if (url === 'https://api.github.com/installation/repositories?per_page=100&page=2') {
            return makeResponse({
              repositories: [
                {
                  name: '.github',
                  full_name: 'alice/.github',
                  owner: { login: 'alice' },
                  html_url: 'https://github.com/alice/.github',
                  private: false,
                  visibility: 'public',
                  fork: false,
                },
              ],
            });
          }
          if (url === 'https://api.github.com/repos/alice/.github/traffic/clones?per=day') {
            return makeResponse({
              clones: [{ timestamp: '2026-03-01T00:00:00Z', count: 4, uniques: 2 }],
            });
          }
          throw new Error(`Unexpected URL: ${url}`);
        },
      });
      assert.equal(relRes.summary.total_cumulative_clones, 4);
      assert.equal(fs.existsSync(path.join(tmpDir, 'data', 'daily', '.github.json')), true);
      assert.equal(fs.existsSync(path.join(tmpDir, 'badges', '.github.json')), true);

      // Protocol-relative cross-origin link is still rejected
      await assert.rejects(
        () =>
          runCollect({
            rootDir: tmpDir,
            token: 'ghs_rel',
            owner: 'alice',
            archiveRepo: 'alice/archive',
            retryDelayMs: 0,
            logger: silentLogger,
            fetchImpl: async () =>
              makeResponse(
                { repositories: [] },
                { headers: { link: '<//evil.example.com/steal>; rel="next"' } },
              ),
          }),
        /cross-origin pagination link/i,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('deduplicates paginated repos, retries 403 rate limits, scopes cross-owner archive exclusion, and handles case-only repo renames', async () => {
    const tmpDir = makeTempDir('traffic-reg-');
    try {
      // 1. Duplicate repo across pages + 403 secondary rate-limit retry + cross-owner same-name repo
      let cloneCalls = 0;
      let rateLimitHits = 0;
      const res1 = await runCollect({
        rootDir: tmpDir,
        token: 'ghs_test',
        owner: 'acme-org',
        archiveRepo: 'alice/repo-traffic-archive',
        fetchedAtUtc: '2026-03-02T02:15:00.000Z',
        retryDelayMs: 0,
        logger: silentLogger,
        fetchImpl: async (url) => {
          if (url === 'https://api.github.com/installation/repositories?per_page=100') {
            return makeResponse(
              {
                repositories: [
                  {
                    name: 'MyRepo',
                    full_name: 'acme-org/MyRepo',
                    owner: { login: 'acme-org' },
                    html_url: 'https://github.com/acme-org/MyRepo',
                    private: false,
                    visibility: 'public',
                    fork: false,
                  },
                ],
              },
              {
                headers: {
                  link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
                },
              },
            );
          }
          if (url === 'https://api.github.com/installation/repositories?per_page=100&page=2') {
            return makeResponse({
              repositories: [
                {
                  name: 'MyRepo',
                  full_name: 'acme-org/MyRepo',
                  owner: { login: 'acme-org' },
                  html_url: 'https://github.com/acme-org/MyRepo',
                  private: false,
                  visibility: 'public',
                  fork: false,
                },
                {
                  name: 'repo-traffic-archive',
                  full_name: 'acme-org/repo-traffic-archive',
                  owner: { login: 'acme-org' },
                  html_url: 'https://github.com/acme-org/repo-traffic-archive',
                  private: false,
                  visibility: 'public',
                  fork: false,
                },
              ],
            });
          }
          if (url === 'https://api.github.com/repos/acme-org/MyRepo/traffic/clones?per=day') {
            cloneCalls += 1;
            if (rateLimitHits === 0) {
              rateLimitHits += 1;
              return makeResponse(
                { message: 'You have exceeded a secondary rate limit' },
                { status: 403, headers: { 'retry-after': '1' } },
              );
            }
            return makeResponse({
              clones: [{ timestamp: '2026-03-01T00:00:00Z', count: 20, uniques: 8 }],
            });
          }
          if (url === 'https://api.github.com/repos/acme-org/repo-traffic-archive/traffic/clones?per=day') {
            return makeResponse({
              clones: [{ timestamp: '2026-03-01T00:00:00Z', count: 5, uniques: 2 }],
            });
          }
          throw new Error(`Unexpected URL: ${url}`);
        },
      });

      assert.equal(cloneCalls, 2); // 1 rate-limit 403 + 1 retry; NOT called again for duplicate page entry
      assert.equal(res1.skippedRepos.length, 0);
      assert.equal(res1.summary.active_public_repos, 2);
      assert.equal(res1.summary.total_cumulative_clones, 25); // 20 + 5, no double counting and org repo not excluded

      // 2. Case-only rename: MyRepo -> myrepo renames ledger & badge cleanly without duplicate files
      const res2 = await runCollect({
        rootDir: tmpDir,
        token: 'ghs_test',
        owner: 'acme-org',
        archiveRepo: 'alice/repo-traffic-archive',
        fetchedAtUtc: '2026-03-03T02:15:00.000Z',
        retryDelayMs: 0,
        logger: silentLogger,
        fetchImpl: async (url) => {
          if (url === 'https://api.github.com/installation/repositories?per_page=100') {
            return makeResponse({
              repositories: [
                {
                  name: 'myrepo',
                  full_name: 'acme-org/myrepo',
                  owner: { login: 'acme-org' },
                  html_url: 'https://github.com/acme-org/myrepo',
                  private: false,
                  visibility: 'public',
                  fork: false,
                },
                {
                  name: 'repo-traffic-archive',
                  full_name: 'acme-org/repo-traffic-archive',
                  owner: { login: 'acme-org' },
                  html_url: 'https://github.com/acme-org/repo-traffic-archive',
                  private: false,
                  visibility: 'public',
                  fork: false,
                },
              ],
            });
          }
          if (url === 'https://api.github.com/repos/acme-org/myrepo/traffic/clones?per=day') {
            return makeResponse({
              clones: [{ timestamp: '2026-03-02T00:00:00Z', count: 10, uniques: 4 }],
            });
          }
          if (url === 'https://api.github.com/repos/acme-org/repo-traffic-archive/traffic/clones?per=day') {
            return makeResponse({ clones: [] });
          }
          throw new Error(`Unexpected URL: ${url}`);
        },
      });

      assert.equal(res2.summary.total_cumulative_clones, 35); // 20 + 10 preserved across case rename + 5
      const dailyFiles = fs.readdirSync(path.join(tmpDir, 'data', 'daily'));
      assert.equal(dailyFiles.includes('myrepo.json'), true);
      assert.equal(dailyFiles.includes('MyRepo.json'), false);
      const badgeFiles = fs.readdirSync(path.join(tmpDir, 'badges'));
      assert.equal(badgeFiles.includes('myrepo.json'), true);
      assert.equal(badgeFiles.includes('MyRepo.json'), false);

      // 3. Exhausted primary rate-limit 403 (x-ratelimit-remaining: 0) fails loudly instead of silently skipping
      await assert.rejects(
        () =>
          runCollect({
            rootDir: tmpDir,
            token: 'ghs_test',
            owner: 'acme-org',
            archiveRepo: 'alice/repo-traffic-archive',
            maxRetries: 1,
            retryDelayMs: 0,
            logger: silentLogger,
            fetchImpl: async (url) => {
              if (url.includes('/installation/repositories')) {
                return makeResponse({
                  repositories: [
                    {
                      name: 'myrepo',
                      full_name: 'acme-org/myrepo',
                      owner: { login: 'acme-org' },
                      html_url: 'https://github.com/acme-org/myrepo',
                      private: false,
                      visibility: 'public',
                      fork: false,
                    },
                  ],
                });
              }
              return makeResponse(
                { message: 'API rate limit exceeded' },
                { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
              );
            },
          }),
        /GitHub API HTTP 403/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('commits accurately from a subdirectory, retries transient 503 GraphQL responses, and rejects merge conflicts', async () => {
    for (const conflict of ['UU data/summary.json\0', 'AA data/summary.json\0', 'DD data/summary.json\0', 'AU README.md\0']) {
      assert.throws(() => parseGitStatusPorcelainZ(conflict), /Unmerged git conflict/);
    }

    const repoDir = makeTempDir('traffic-subdir-git-');
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test Bot'], { cwd: repoDir });

      fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'README.md'), 'v1\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

      fs.writeFileSync(path.join(repoDir, 'README.md'), 'v2\n', 'utf8');

      let gqlAttempts = 0;
      const res = await commitVerifiedChanges({
        cwd: path.join(repoDir, 'scripts'),
        token: 'ghs_sub',
        repoWithOwner: 'alice/repo-traffic-archive',
        branchName: 'main',
        retryDelayMs: 0,
        logger: silentLogger,
        fetchImpl: async () => {
          gqlAttempts += 1;
          if (gqlAttempts === 1) {
            return makeResponse('Service Unavailable', { status: 503 });
          }
          return makeResponse({
            data: {
              createCommitOnBranch: {
                commit: { oid: 'c'.repeat(40), url: 'https://github.com/alice/repo-traffic-archive/commit/' + 'c'.repeat(40) },
              },
            },
          });
        },
      });
      assert.equal(gqlAttempts, 2);
      assert.equal(res.changed, true);
      assert.equal(res.commitSha, 'c'.repeat(40));
      assert.equal(res.additionsCount, 1);

      // Symlink rejection via lstatSync (skip cleanly if OS denies symlink creation)
      fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });
      const targetFile = path.join(repoDir, 'secret.txt');
      const linkFile = path.join(repoDir, 'data', 'link.json');
      fs.writeFileSync(targetFile, 'secret\n', 'utf8');
      let symlinkCreated = false;
      try {
        fs.symlinkSync(targetFile, linkFile);
        symlinkCreated = true;
      } catch (err) {
        if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      }
      if (symlinkCreated) {
        await assert.rejects(
          () =>
            commitVerifiedChanges({
              cwd: repoDir,
              token: 'ghs_sub',
              repoWithOwner: 'alice/repo-traffic-archive',
              branchName: 'main',
              retryDelayMs: 0,
              logger: silentLogger,
              fetchImpl: async () => {
                throw new Error('Should not call GraphQL when symlink is present');
              },
            }),
          /non-file or symlink/i,
        );
      }
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('workflow safely resolves repo metadata on schedule & workflow_dispatch and includes dotfile subjects', async () => {
    const http = await import('node:http');
    const workflowPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '.github',
      'workflows',
      'collect-clones.yml',
    );
    const workflowText = fs.readFileSync(workflowPath, 'utf8');

    assert.equal(workflowText.includes('\r'), false, 'Workflow YAML must be LF-only');
    assert.equal(
      workflowText.includes('repositories: ${{ github.event.repository.name }}'),
      false,
      'write-token must not rely on github.event.repository.name (empty on schedule)',
    );
    assert.equal(
      workflowText.includes('github.event.repository.private == false'),
      false,
      'attestation gate must not rely on github.event.repository.private (empty on schedule)',
    );
    assert.ok(workflowText.includes('repositories: ${{ steps.repo-meta.outputs.repo_name }}'));
    assert.ok(workflowText.includes("steps.repo-meta.outputs.is_public == 'true'"));
    assert.ok(workflowText.includes('data/daily/.*.json'));
    assert.ok(workflowText.includes('badges/.*.json'));

    // Extract and execute the embedded repo-meta Node script against a local HTTP server
    const scriptMatch = workflowText.match(/node --input-type=module <<'EOF'\n([\s\S]*?)\n\s*EOF/);
    assert.ok(scriptMatch, 'Expected embedded repo-meta Node script in workflow');
    const scriptBody = scriptMatch[1].replace(/^ {10}/gm, '');

    let apiHits = 0;
    let mockPrivate = false;
    const server = http.createServer((req, res) => {
      apiHits += 1;
      assert.equal(req.url, '/repos/alice/repo-traffic-archive');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ private: mockPrivate, default_branch: 'master' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const tmpDir = makeTempDir('traffic-workflow-meta-');

    try {
      // Case A: schedule trigger (EVENT_REPO_* empty) on public repo with default branch "master"
      const scheduleOut = path.join(tmpDir, 'schedule_out.txt');
      await execFileAsync(process.execPath, ['--input-type=module', '-e', scriptBody], {
        env: {
          ...process.env,
          GITHUB_REPOSITORY: 'alice/repo-traffic-archive',
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          GITHUB_OUTPUT: scheduleOut,
          GH_TOKEN: 'ghs_fake',
          EVENT_REPO_NAME: '',
          EVENT_REPO_PRIVATE: '',
          EVENT_DEFAULT_BRANCH: '',
        },
      });
      assert.equal(apiHits, 1);
      const scheduleText = fs.readFileSync(scheduleOut, 'utf8');
      assert.ok(scheduleText.includes('repo_name=repo-traffic-archive\n'));
      assert.ok(scheduleText.includes('is_public=true\n'));
      assert.ok(scheduleText.includes('default_branch=master\n'));

      // Case B: schedule trigger on private repo => is_public=false
      mockPrivate = true;
      const privateOut = path.join(tmpDir, 'private_out.txt');
      await execFileAsync(process.execPath, ['--input-type=module', '-e', scriptBody], {
        env: {
          ...process.env,
          GITHUB_REPOSITORY: 'alice/repo-traffic-archive',
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          GITHUB_OUTPUT: privateOut,
          GH_TOKEN: 'ghs_fake',
          EVENT_REPO_NAME: '',
          EVENT_REPO_PRIVATE: '',
          EVENT_DEFAULT_BRANCH: '',
        },
      });
      assert.equal(apiHits, 2);
      assert.ok(fs.readFileSync(privateOut, 'utf8').includes('is_public=false\n'));

      // Case C: workflow_dispatch (EVENT_REPO_* populated) => 0 extra API calls
      const dispatchOut = path.join(tmpDir, 'dispatch_out.txt');
      await execFileAsync(process.execPath, ['--input-type=module', '-e', scriptBody], {
        env: {
          ...process.env,
          GITHUB_REPOSITORY: 'alice/repo-traffic-archive',
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          GITHUB_OUTPUT: dispatchOut,
          GH_TOKEN: 'ghs_fake',
          EVENT_REPO_NAME: 'repo-traffic-archive',
          EVENT_REPO_PRIVATE: 'false',
          EVENT_DEFAULT_BRANCH: 'main',
        },
      });
      assert.equal(apiHits, 2); // No extra API call needed!
      const dispatchText = fs.readFileSync(dispatchOut, 'utf8');
      assert.ok(dispatchText.includes('repo_name=repo-traffic-archive\n'));
      assert.ok(dispatchText.includes('is_public=true\n'));
      assert.ok(dispatchText.includes('default_branch=main\n'));
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
