# 公开仓累积克隆数权威归档（Repo Traffic Archive）

零第三方依赖（纯 Node.js 20+ ESM）的 GitHub 公开仓库克隆流量长期归档模板。每日 UTC `02:15` 自动采集全部公开仓的 14 天滚动克隆明细、按 UTC 自然日幂等累加并永久留存历史，自动输出 Shields.io 徽章 JSON、通过 GitHub GraphQL API 生成带 **Verified** 签名的提交，并调用 `actions/attest@v4` 写入 Sigstore / Rekor 密码学存证，供任何第三方独立核验。

---

## 统计看板

<!-- TRAFFIC_TABLE:START -->
- **累计总克隆数（`cumulative_clones`）**：`6,539`
- **日独立克隆人数累加值（`sum_of_daily_uniques`，仅趋势参考）**：`4,320`
- **纳入统计仓库**：活跃公开仓 `9` 个 / 历史保留仓 `0` 个
- **统计起始日期（UTC）**：`2026-11-10` ｜ **最近更新（UTC）**：`2026-11-28T10:29:34.014Z`

| 仓库 | 状态 | 起始日期 (UTC) | 累计克隆数 | 日独立克隆累加* | 单仓徽章 |
| --- | --- | :---: | ---: | ---: | :---: |
| [Antigravity-agy-dart](https://github.com/zou172866/Antigravity-agy-dart) | Active | 2026-11-10 | 3,934 | 2,669 | ![Antigravity-agy-dart clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/Antigravity-agy-dart.json) |
| [Antigravity-agy-cmd](https://github.com/zou172866/Antigravity-agy-cmd) | Active | 2026-11-10 | 1,682 | 1,156 | ![Antigravity-agy-cmd clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/Antigravity-agy-cmd.json) |
| [xiaozhi-windows-pc-mcp](https://github.com/zou172866/xiaozhi-windows-pc-mcp) | Active | 2026-11-10 | 410 | 188 | ![xiaozhi-windows-pc-mcp clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/xiaozhi-windows-pc-mcp.json) |
| [agy-ignore](https://github.com/zou172866/agy-ignore) | Active | 2026-11-12 | 170 | 100 | ![agy-ignore clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/agy-ignore.json) |
| [Antigravity-agy-human](https://github.com/zou172866/Antigravity-agy-human) | Active | 2026-11-11 | 131 | 71 | ![Antigravity-agy-human clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/Antigravity-agy-human.json) |
| [svg-voiced-video-studio](https://github.com/zou172866/svg-voiced-video-studio) | Active | 2026-11-10 | 102 | 65 | ![svg-voiced-video-studio clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/svg-voiced-video-studio.json) |
| [agy-xiaozhi-notifier](https://github.com/zou172866/agy-xiaozhi-notifier) | Active | 2026-11-10 | 90 | 55 | ![agy-xiaozhi-notifier clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/agy-xiaozhi-notifier.json) |
| [-edge-subtitle-plugin-Edge-](https://github.com/zou172866/-edge-subtitle-plugin-Edge-) | Active | 2026-11-10 | 20 | 16 | ![-edge-subtitle-plugin-Edge- clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/-edge-subtitle-plugin-Edge-.json) |
| [chooselove](https://github.com/zou172866/chooselove) | Active | 2026-11-15 | 0 | 0 | ![chooselove clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/chooselove.json) |

> \* `sum_of_daily_uniques` 为各 UTC 自然日 `uniques` 之和，不可解释为跨日去重后的历史总人数；权威累积总数请以 `cumulative_clones` 为准。
<!-- TRAFFIC_TABLE:END -->

---

## Shields.io 徽章引用（复制即用）

直接复制下方 Markdown 贴入个人主页 README 或各项目 README（单仓徽章仅需替换 `<TARGET_REPO>` 为对应仓库名）：

### 1. 账号公开仓累计总克隆数

```markdown
![Total Public Clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/total-clones.json)
```

### 2. 单个公开仓累计克隆数

```markdown
![Repo Clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/<TARGET_REPO>.json)
```

> 可选样式：若希望数字显示为紧凑格式（如 `1.2k`、`3.4M`），可在仓库 **Variables** 中设置 `BADGE_NUMBER_STYLE=compact`（默认 `exact` 千分位精确数字，如 `1,284`）；可通过 `BADGE_COLOR` 自定义十六进制颜色（默认 `0969da`）。

---

## 第三方独立核验（Sigstore Attestation）

本仓配备 `.gitattributes` 强制 `LF` 换行，确保任意系统克隆后的 JSON 字节哈希与工作流存证完全一致。任何第三方可执行以下命令校验数据是否确由本仓库 GitHub Actions 工作流生成且未被人工篡改：

```bash
git clone https://github.com/zou172866/repo-traffic-archive.git
cd repo-traffic-archive

# 校验全账号汇总文件
gh attestation verify data/summary.json --owner zou172866

# 校验指定单仓每日明细账本或徽章文件
gh attestation verify data/daily/<TARGET_REPO>.json --owner zou172866
gh attestation verify badges/total-clones.json --owner zou172866
```

> 核验重点：除验证签名通过外，建议同时查看输出的 `workflow` 路径（应为 `.github/workflows/collect-clones.yml`）以及该仓库 `main` 分支的 Rulesets 保护规则与提交记录上的 **Verified** 标记。

---

## 快速启用指南

### 前置步骤：推送模板到公开归档仓

1. 在 GitHub 新建一个**公开（Public）**仓库（例如 `repo-traffic-archive`）。
2. 将本目录初始化并推送到 `main` 分支：
   ```bash
   git init -b main
   git add .
   git commit -m "chore: bootstrap repo-traffic-archive"
   git remote add origin https://github.com/zou172866/repo-traffic-archive.git
   git push -u origin main
   ```

---

### 方案 A（推荐）：GitHub App 最小权限双 Token + Verified 签名提交

工作流在运行时按需签发两枚短生命周期 Token，并在任务结束自动吊销：
- **Read Token**：覆盖账号下已安装仓库，仅限 `administration: read` + `metadata: read`，对任何业务仓无写权限。
- **Write Token**：仅限定当前归档仓，仅限 `contents: write`，通过 `createCommitOnBranch` 提交，自动获得 GitHub 官方 **Verified** 签名。

1. **创建 GitHub App**：进入 `Settings → Developer settings → GitHub Apps → New GitHub App`：
   - **GitHub App name**：任意唯一名称（例如 `zou172866-traffic-archiver`）。
   - **Homepage URL**：填写当前归档仓地址。
   - **Webhook**：取消勾选 `Active`（本模板无需接收 Webhook）。
   - **Repository permissions**：
     - `Administration` → **Read-only**（读取 `/traffic/clones` 必需）
     - `Contents` → **Read and write**（仅在运行时由 Write Token 限定写归档仓）
     - `Metadata` → **Read-only**（自动勾选）
   - **Where can this GitHub App be installed?** → 选择 **Only on this account**。
   - 点击 **Create GitHub App**。
2. **获取 Client ID 与私钥**：
   - 在 App 详情页复制 **Client ID**（形如 `Iv23li...`）。
   - 下拉到 **Private keys** 点击 **Generate a private key**，下载 `.pem` 文件（切勿提交进仓库）。
3. **安装到你的账号**：
   - 在 App 左侧点击 **Install App** → 安装到你的个人账号或组织，选择 **All repositories**（推荐，新公开仓自动纳入）或手动勾选需要统计的公开仓 + 当前归档仓。
4. **配置归档仓 Variables & Secrets**（归档仓 `Settings → Secrets and variables → Actions`）：
   - **Variables** 新增：`APP_CLIENT_ID` = 步骤 2 复制的 Client ID。
   - **Secrets** 新增：`APP_PRIVATE_KEY` = 步骤 2 下载的 `.pem` 文件完整内容（含 `BEGIN/END RSA PRIVATE KEY` 头尾）。
5. **首次试跑**：进入归档仓 `Actions → Collect Public Repo Clones → Run workflow`，验证运行成功并生成 `data/`、`badges/` 与 **Verified** 提交。

---

### 方案 B（快速起步）：Fine-grained PAT 模式

如果不方便立即创建 GitHub App，可先使用 Fine-grained PAT 运行（工作流会在日志中提示当前处于 PAT 回退模式）：

1. 进入 `Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token`。
2. **Repository access**：选择 **All repositories**（或指定公开仓 + 当前归档仓）。
3. **Repository permissions**：
   - `Administration`: **Read-only**
   - `Contents`: **Read and write**（用于提交归档数据）
   - `Metadata`: **Read-only**
4. 在归档仓 `Settings → Secrets and variables → Actions → Secrets` 中新增 `TRAFFIC_PAT`，粘贴生成的 Token（保持 `APP_CLIENT_ID` 为空即可自动走 PAT 分支）。
5. 建议后续仍切换为方案 A，以实现读写权限彻底分离并获得 App 签名的 **Verified** 提交。

---

### 可选仓库变量（Repository Variables）

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `GITHUB_OWNER` | 当前仓库所有者 | 采集目标账号或组织名 |
| `INCLUDE_FORKS` | `false` | 设为 `true` 时将公开 Fork 仓纳入统计 |
| `INCLUDE_ARCHIVE_REPO` | `false` | 默认排除归档仓自身，防止每日 Actions Checkout 自刷计数 |
| `EXCLUDE_REPOS` | 空 | 逗号分隔的额外排除仓库列表（支持 `repo` 或 `owner/repo`） |
| `BADGE_NUMBER_STYLE` | `exact` | 徽章数字格式：`exact`（`1,284`）或 `compact`（`1.2k`、`3.4M`） |
| `BADGE_COLOR` | `0969da` | Shields.io 徽章颜色（不含 `#`） |
| `HEARTBEAT_COMMIT` | `false` | 设为 `true` 时，即便无新增克隆数也更新时间戳并提交存证 |

---

## 配置 Repository Rulesets 锁死 `main` 防篡改

要让第三方相信账本数据无法被仓库所有者事后改写，建议在归档仓启用 **Repository Rulesets**，将 `main` 分支写入权限严格收口给上述 GitHub App：

1. 进入归档仓 `Settings → Rules → Rulesets → New ruleset → New branch ruleset`。
2. **Ruleset Name**：`protect-traffic-archive-main`，**Enforcement status**：`Active`。
3. **Target branches**：点击 `Add target → Include default branch`（即 `main`）。
4. **Bypass list**：
   - **仅添加你在方案 A 创建的 GitHub App**（设为 `Always allow`），不要把个人账号 / Admin 放进 Bypass list（如需升级脚本或工作流，通过 PR 走完整公开审计记录，或仅允许特定审批流程）。
5. **Branch rules** 勾选：
   - `Restrict deletions`（禁止删分支）
   - `Block force pushes`（禁止强推重写历史）
   - `Require signed commits`（配合方案 A 的 GraphQL `createCommitOnBranch`，拒绝未签名本地推送）
   - `Require a pull request before merging`（阻断人类直接向 `main` 推送人工改数；仅 Bypass list 中的 GitHub App 可自动写入每日归档提交）
6. 点击 **Create** 保存。

---

## 数据口径与透明边界

1. **严格公开仓范围**：仅统计 `private === false` 且 `visibility === "public"` 的仓库；默认跳过 Fork 与归档仓自身。已删除、转私有或不再出现的历史公开仓会标记为 `active: false` 并保留全部历史日明细，绝不丢失既有累积值。
2. **14 天冷启动限制**：GitHub Traffic API 仅提供过去 14 天内的每日克隆数据。启用本归档后，系统只能从首次采集日前 14 天起累计，无法追溯更早的历史数据（每个仓库账本与总表均显式记录 `tracking_since`）。
3. **按 UTC 日期幂等去重**：严禁累加 API 顶层 14 天总和；脚本以 `clones[].timestamp.slice(0, 10)`（UTC `YYYY-MM-DD`）为主键覆写窗口内记录，保留 14 天外的历史记录，重复运行或重叠拉取不会重复计数。
4. **`cumulative_clones` 与 `sum_of_daily_uniques` 的区别**：
   - `cumulative_clones`：各 UTC 自然日 `count` 的精确总和，数学上可严格累加；该数值包含真实开发者克隆，也包含 CI/CD Runner、镜像同步与自动化爬虫产生的 `git clone`。
   - `sum_of_daily_uniques`：各 UTC 自然日 `uniques` 之和，仅反映日活克隆规模趋势，**不能**宣称为跨天去重后的历史独立总人数（同一人在两天克隆会被计入两天）。
5. **本地测试与审计**：本仓库零外部依赖，本地可直接运行：
   ```bash
   npm test
   ```
