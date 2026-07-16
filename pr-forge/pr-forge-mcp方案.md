<!-- /autoplan restore point: /Users/wangchenglong/.gstack/projects/hsoft-data-manage/main-autoplan-restore-20260715-092347.md -->

# pr-forge v3.0 架构方案

> AI 代码变更安全网关 — Agent 修改代码必须走 PR 审查，验证通过后方可合并。任何 Agent 平等协作，不绑角色。

---

## 一、语言迁移：Python → Node.js

**决策：** 从 Python 迁移到 Node.js，仅 `eslint` + `@eslint/js` 作为开发依赖。

**理由：**

- 目标用户（Claude Code / Codex / Cursor 使用者）已预装 Node.js
- Python 是额外依赖，每多一步就流失一批用户
- 通过 `npx pr-forge` 实现零安装运行
- eslint 仅作为 devDependency 用于项目自身 lint 和 CI 验证

**v2 兼容：** v2 Python 版保留但标记 EOL。v2 审查数据通过 PR comment 中的 marker（`<!-- review-phase: N -->` + `<!-- review-commit: SHA -->`）向后兼容读取，`get_review_status` 在 Check Run 不存在时降级搜索 v2 marker。

---

## 二、项目结构

```
pr-forge/
├── package.json
├── README.md
├── eslint.config.js              # ESLint flat config (Node.js globals)
├── .github/workflows/
│   └── publish.yml              # CI: tag push → node --test → npm publish
├── src/
│   ├── cli.js                    # CLI 入口: init / auth / doctor / MCP server 四模式
│   ├── cli-init.js               # pr-forge init 命令
│   ├── cli-auth.js               # pr-forge auth 命令 (GitHub App Manifest Flow)
│   ├── cli-doctor.js             # pr-forge doctor 命令
│   ├── server.js                 # MCP JSON-RPC over stdin/stdout
│   ├── config.js                 # 配置加载 + SHA256 hash 校验
│   ├── context.js                # git remote 检测 + 平台解析
│   ├── init.js                   # 项目初始化 (config生成/token/credentials)
│   ├── doctor.js                 # 环境诊断逻辑
│   ├── lock.js                   # 文件锁 (排他创建 + PID 验活 + 死锁恢复)
│   ├── error-codes.js            # 24 个统一错误码
│   ├── tools/
│   │   ├── context.js            # get_pr_context
│   │   ├── review.js             # get_review_plan + get_review_status
│   │   ├── code.js               # get_pr_diff + get_file_content
│   │   ├── git.js                # commit_and_push
│   │   ├── checks.js             # run_pr_checks
│   │   └── conclusion.js         # set_conclusion + merge_pr
│   └── platforms/
│       ├── router.js             # 平台检测 + 工厂
│       ├── github.js             # GitHub API + Check Runs
│       └── gitee.js              # Gitee API + Commit Status
```

**唯一依赖：** Node.js 20+

---

## 三、CLI 入口

`pr-forge` CLI 四模式切换（`src/cli.js`）：

```
pr-forge init               → 项目初始化向导
pr-forge auth               → GitHub App 授权 (Manifest Flow)
pr-forge doctor             → 环境诊断
pr-forge [--version|-v]     → 输出版本号
pr-forge                    → 启动 MCP server (JSON-RPC over stdin/stdout)
```

**MCP JSON-RPC 传输层**（`src/server.js`）：
- 从 stdin 逐行读取 JSON-RPC 消息，通过 `readlineFromStdin` 异步迭代器处理 chunk 拼接
- `chunk.splice(0, chunks.length, <tail>)` 保留最后一个不完整行，避免 JSON parse 失败
- 支持四种消息：`initialize`、`tools/list`、`tools/call`、`notifications/initialized`
- `serverInfo` 返回 `{ name: 'pr-forge', version: '3.0.0' }`

**平台检测**（`src/context.js`）：
- 从 `git config --get remote.origin.url` 正则匹配 GitHub/Gitee
- Token 读取优先级：`PR_FORGE_TOKEN` > `GITHUB_TOKEN` > `GITEE_TOKEN`
- `resolvePlatform(env)` → 返回平台实例，失败返回 `null`（所有工具调用均校验 `this.platform` 非空）

---

## 四、安全模型

### config.json 防篡改

`run_pr_checks` 执行任意 shell 命令。为防止 Agent 或恶意修改篡改 `.pr-forge/config.json`：

1. `pr-forge init` 生成 `config.json` 时计算 SHA256 hash，存入 `.pr-forge/.approved`
2. `run_pr_checks` 每次执行前调用 `verifyConfig()` 对比当前 hash 与 `.approved` 中记录
3. hash 一致 → 正常执行
4. hash 不一致 → 拒绝执行，返回 `CONFIG_MODIFIED`

`config.js` 提供四个函数：`loadConfig()`、`verifyConfig()`、`writeApproved()`、`getConfigHash()`。

向后兼容：`loadConfig()` 检测旧的 `check` 字段（无 `phases`），自动转换为单阶段 `[{ id: 'default', name: '验证', check: '...' }]`。

> **安全边界：** 此校验防御的是 Agent 或用户无意中修改 `config.json` 导致后续 `run_pr_checks` 执行意外命令的场景。任何有文件系统写权限的进程都可以同时修改 `config.json` 和 `.approved` 来绕过校验，因此这不是对抗恶意篡改的机制。对于恶意修改，信任边界应建立在平台侧（Check Run 状态 + 分支保护规则）。

### Token 存储

Token 需要在 `mcp.json` 的 env 字段中供运行时读取，但必须防止误提交到仓库：

- Token 写入 `.claude/mcp.json` 的 env 字段（`PR_FORGE_TOKEN`）
- `init` 自动将 `.claude/mcp.json` 加入项目的 `.gitignore`
- Token 同时备份到 `~/.pr-forge/credentials`（JSON 格式: `{ token, created_at }`，文件权限 `0o600`，目录 `0o700`）。GitHub App 模式存储 `{ appId, privateKey, installationId?, created_at }`
- `pr-forge init` 检测到 `~/.pr-forge/credentials` 已有 token → 直接复用，不再询问
- `init` 输出警告："mcp.json 已加入 .gitignore，不要手动取消"

---

## 五、MCP 工具清单（v3.0，共 9 个）

| # | 工具 | 参数 | 功能 |
|---|------|------|------|
| 1 | `get_pr_context` | `pr_number` | PR 元数据（title/state/draft/SHA/branch/author） |
| 2 | `get_review_status` | `pr_number`, `branch?` | 读各 phase Check Run 结论 + 完整审查报告（含聚合状态）。拉取 Check Run 时校验其关联 SHA 与 PR 当前 head SHA 是否一致，不一致标记为 `stale`。支持 `branch` 参数反查 PR |
| 3 | `get_pr_diff` | `pr_number`, `max_bytes?` | 获取 PR unified diff |
| 4 | `get_file_content` | `path`, `ref?` | 获取仓库文件内容 |
| 5 | `commit_and_push` | `message`, `pr_number?`, `branch?`, `files?`, `reviewer?`, `title?` | 提交修复并推送到 PR 分支。branch 可选（默认当前分支），push 后自动检测/创建 PR，返回 `pr_number`。支持 `reviewer` 写入 PR body 标记 |
| 6 | `merge_pr` | `pr_number`, `merge_method?`, `acknowledge?` | 合并 PR（两层门禁：事实层聚合 + 审查意见）。`acknowledge` 默认 `false`，审查意见 `neutral` 时必须传 `acknowledge=true` |
| 7 | `run_pr_checks` | `pr_number`, `phase?`, `timeout?` | 执行 config.json 的 check 命令（多阶段），各 phase 独立写 Check Run |
| 8 | `set_conclusion` | `pr_number`, `conclusion`, `report_text?` | 修改 Check Run 整体结论，附带审查报告。更新已有结论时校验 SHA 防过期 |
| 9 | `get_review_plan` | `pr_number?`, `branch?`, `reviewer?` | 动态生成审查步骤清单。无参数返回全部 open PR 列表，支持 `reviewer` 过滤（匹配 PR body 中 `<!-- pr-forge-reviewer: xxx -->` 标记） |

### 工具返回格式

工具返回统一结构为 `{ ok: true|false, ... }`。以下定义三个核心工具的返回 schema。

**`get_review_plan` 返回：**

```json
{
  "ok": true,
  "pr": { "number": 42, "title": "fix: ...", "head_sha": "abc123" },
  "prerequisites": {
    "config_exists": true,
    "git_clean": true,
    "token_valid": true
  },
  "phases": [
    { "id": "lint", "name": "代码检查", "check_run_status": "completed", "conclusion": "success" },
    { "id": "test", "name": "单元测试", "check_run_status": "not_started", "conclusion": null }
  ],
  "conclusion_status": "not_set",
  "merge_ready": false,
  "next_action": "run_pr_checks",
  "next_params": { "pr_number": 42, "phase": "test" },
  "blocker": null,
  "blocker_resolution": null
}
```

`next_action` 是 Agent 下一步该调的工具名，`next_params` 是调用参数。Agent 不需要推理，拿起来就用。`prerequisites` 让首次调用就能告诉 Agent "config.json 不存在，先让用户 `pr-forge init`"。

**`get_review_status` 返回：**

```json
{
  "ok": true,
  "pr": { "number": 42, "head_sha": "abc123" },
  "phases": {
    "lint": { "conclusion": "success", "sha_verified": true, "completed_at": "..." },
    "test": { "conclusion": "failure", "sha_verified": true, "completed_at": "..." },
    "audit": { "conclusion": null, "sha_verified": false, "stale": true }
  },
  "conclusion": { "conclusion": "neutral", "report_sha": "abc123" },
  "aggregate": "failure",
  "merge_blocked": true,
  "merge_block_reason": "test phase 未通过",
  "source": "check_runs"
}
```

`sha_verified` 和 `stale` 让 Agent 一眼看到哪些 phase 的 SHA 过期了。

**`run_pr_checks` 返回：**

```json
{
  "ok": true,
  "executed": ["lint", "test", "audit"],
  "results": {
    "lint": { "conclusion": "success", "exit_code": 0, "duration_ms": 1200, "output_summary": "..." },
    "test": { "conclusion": "failure", "exit_code": 1, "duration_ms": 34000, "output_summary": "2 tests failed..." }
  },
  "aggregate": "failure",
  "warnings": ["code_updated_during_check"],
  "next_suggestion": "修复失败阶段后重跑 run_pr_checks"
}
```

错误时统一返回：

```json
{
  "ok": false,
  "error": {
    "code": "LOCKED",
    "message": "并发锁被占用，另一个 run_pr_checks 正在同一 PR 上执行",
    "recovery": "等待当前执行完成（锁文件会在执行结束后自动释放），1-2 分钟后重试。如确认没有并发执行，可手动删除 .pr-forge/locks/pr-{n}.lock",
    "context": { "lock_file": ".pr-forge/locks/pr-42.lock", "pid": 12345 }
  }
}
```

---

## 六、`run_pr_checks` — 配置文件驱动的多阶段验证

**约定：** 项目根目录 `.pr-forge/config.json`：

```json
{
  "version": "3.0",
  "timeout": 300,
  "phases": [
    { "id": "verify", "name": "验证", "check": "npm run lint && npm test", "timeout": 600 }
  ]
}
```

`phase.timeout` 覆盖全局 `timeout` 值，不设则继承。`phases` 为数组，按顺序执行。每个 phase 有唯一 `id`、显示用的 `name` 和要执行的 `check` 命令。向后兼容：如果只有 `check` 字段（无 `phases`），`loadConfig()` 自动转换为单阶段 `[{ "id": "default", "name": "验证", "check": "..." }]`。

### 纯文档变更跳过

在 checkout PR 分支后，`run_pr_checks` 先通过 `hasCodeChanges()` 判断 diff 是否只包含文档文件：

- **文档扩展名**：`.md`, `.txt`, `.rst`, `.adoc`, `.markdown`, `.mdown`
- **文档文件名模式**：`README*`, `CHANGELOG*`, `CONTRIBUTING*`, `LICENSE*`

如果 diff 中所有文件都匹配以上规则，则跳过所有 phase 执行，Check Run 直接标记 `success`，summary 为 "跳过: 仅文档变更，无需运行代码检查"。否则正常执行 check 命令。

**工具签名：**

`run_pr_checks(pr_number, phase?)` — 不传 `phase` 则执行所有阶段；传 `phase`（phase id）则只执行指定阶段。

**执行方式：**

`run_pr_checks` 内部使用 Node `execSync(config.check, { timeout, stdio: ['pipe', 'pipe', 'pipe'] })`。

**工具行为：**

1. 安全校验：`verifyConfig()` 对比 `.pr-forge/config.json` hash 与 `.pr-forge/.approved`
2. git status 预检：`git status --porcelain` 确认工作区干净，有未提交修改则返回 `DIRTY_WORKTREE`
3. 并发控制：获取文件锁 `.pr-forge/locks/pr-{n}.lock`（`fs.writeFileSync(lp, PID, { flag: 'wx' })` 排他创建 + PID 写入），已被占用则 `process.kill(pid, 0)` 检查 PID 是否存活，进程已死则清理死锁并递归重试，存活则返回 `LOCKED`
4. 记录原分支 HEAD SHA：`ORIG_SHA=$(git rev-parse HEAD)`
5. `git fetch origin pull/{pr}/head:pr-{pr}`
6. `git checkout pr-{pr}`
7. 按顺序执行 phases，每个 phase 独立记录 exit code / stdout / stderr。**check 命令应为只读操作（lint/test/vet），不应修改代码**
8. 执行后校验 PR head SHA 是否变化（`currentSha !== prHeadSha`），变化则在 `warnings` 中标注 `code_updated_during_check`
9. 切回原分支：`git checkout $ORIG_SHA`（使用 SHA 而非分支名），释放锁（`releaseLock()` — 删除 lock 文件）
10. 每个 phase 结果独立写入 Check Run / Commit Status，Check Run name 为 `pr-forge/{phase-id}`（例如 `pr-forge/lint`、`pr-forge/test`）

**两层结论模型（事实层 + 审查意见层）：**

v3 有两层结论，分别存储在不同 Check Run 中：

| 层 | 写工具 | Check Run name | 含义 |
|---|--------|---------------|------|
| 事实层 | `run_pr_checks` | `pr-forge/{phase-id}` | 各 phase 验证结果（自动化） |
| 审查意见层 | `set_conclusion` | `pr-forge/conclusion` | 审查 Agent 的最终判定（人工/AI 判断） |

**Check Run 命名约定：**

- 事实层：`pr-forge/{phase-id}` — 由 `config.json` 中每个 phase 的 `id` 决定。`get_review_status` 通过 `check_name` 过滤精确拉取各 phase 状态（`PR_FORGE_CHECK_RUN_PREFIX = 'pr-forge/'`）
- 审查意见层：`pr-forge/conclusion` — `set_conclusion` 写入，`merge_pr` 读取

**事实层聚合规则**（各 phase 独立 Check Run 的 AND 聚合）：
- 所有 phase 均为 `success` → 验证通过
- 任一 phase 为 `failure` → 验证不通过
- 任一 phase 为 `neutral` 且无 `failure` → 验证带风险

**`merge_pr` 决策逻辑**（两层 AND）：
1. 事实层聚合 → `failure`：永远拒绝合并（验证未过）
2. 事实层聚合 → `success`，审查意见层 → `success`：合并
3. 事实层聚合 → `success`，审查意见层 → `neutral`：需 `acknowledge=true` 确认
4. 审查意见层 → 不存在：拒绝，"审查未完成，请调 set_conclusion"
5. 事实层 Check Run 不存在 + v2 compat 也失败 → 拒绝，"未执行 run_pr_checks，禁止合并"

---

## 七、平台适配

### 平台路由（`src/platforms/router.js`）

`detectPlatform({ remote })` 正则匹配 `github.com[:/]owner/repo` 或 `gitee.com[:/]owner/repo`。

`createPlatform(platform, token, owner, repo)` 工厂方法，返回 `GitHubPlatform` 或 `GiteePlatform` 实例。

### GitHub（`src/platforms/github.js` — Check Runs）

| 能力 | 实现 |
|------|------|
| 验证结果 | Check Runs API (`POST /repos/:owner/:repo/check-runs`) |
| 审查报告 | Check Run `output` 字段（title/summary/text） |
| 合并阻断 | 分支保护规则（原生） |
| 三种结论 | `success` / `failure` / `neutral` |
| 报告长度限制 | 65535 字符，超限自动截断并标注 |
| API headers | `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` |
| Rate limit | 检测 `x-ratelimit-remaining === '0'` → 返回 `RATE_LIMITED` |

### Gitee（`src/platforms/gitee.js` — Commit Status）

| 能力 | 实现 |
|------|------|
| 验证结果 | Commit Status API (`POST /repos/:owner/:repo/commits/:sha/statuses`) |
| 合并阻断 | 仓库设置手动开启 CI 检查 |
| 两种状态 | `success` / `failure` |
| neutral 替代 | `success` 状态 + `merge_pr` 内部拒绝（策略 C） |
| 审查报告 | PR comment（Commit Status 无 output 字段） |
| Check Run 模拟 | `createCheckRun` → `createCommitStatus`; `listCheckRuns` → 过滤 `pr-forge/` 前缀的 status |

### 结论状态映射

| 审查结论 | GitHub | Gitee |
|----------|--------|-------|
| 全过 | Check Run: `success` | Commit Status: `success` |
| 挂了 | Check Run: `failure` | Commit Status: `failure` |
| 通过但有风险 | Check Run: `neutral` | Commit Status: `success` + merge_pr 走 `acknowledge=true` 逻辑 |

### Token 权限对照

| 操作 | GitHub（最小权限） | Gitee |
|------|--------------------|-------|
| 读 PR | `repo`（私有）/ `public_repo`（公开） | `pull_requests` |
| Check Run / Commit Status | `repo` / `repo:status` | `projects` |
| 读文件 | `repo` / `public_repo` | `projects` |
| 合并 PR | `repo` | `pull_requests` |

---

## 八、合并门禁（`merge_pr` + `set_conclusion`）

**三个工具配合：**

| 工具 | 谁调 | 做什么 |
|------|------|--------|
| `run_pr_checks` | 任何 Agent | 跑验证（可多阶段），各 phase 独立写入 Check Run / Commit Status |
| `set_conclusion` | 审查 Agent | 写审查意见 + 附带审查报告 → 写入 `pr-forge/conclusion` Check Run |
| `merge_pr` | 任何 Agent | 读事实层聚合 + 审查意见层，两层 AND 决策 |

**`merge_pr` 决策逻辑（`src/tools/conclusion.js`）：**

```
0. 事实层 Check Run 不存在 → 尝试 v2 兼容路径
   → v2 compat source === 'v2_compat' + success → 直接合并
   → v2 compat source === 'v2_compat' + neutral + acknowledge=true → 合并
   → v2 compat source === 'v2_compat' + expired → REVIEW_STALE
   → 无 v2 数据 → "未执行 run_pr_checks，禁止合并"
1. 校验各 phase Check Run + 审查意见 Check Run 的关联 SHA 与 PR 当前 head SHA
   // 任一 phase SHA 不一致即整体拒绝
2. SHA 不一致 → REVIEW_STALE
3. phaseCheckRuns.length === 0 → 拒绝，"未执行 run_pr_checks"
4. hasFailure → 拒绝，"验证未通过，先修复"
5. !conclusionCheckRun → 拒绝，"审查未完成，请调 set_conclusion"
6. conclusion === 'success' → 合并
7. conclusion === 'neutral' + acknowledge=true → 合并
8. conclusion === 'neutral' + !acknowledge → 拒绝
9. conclusion === 'failure' → 拒绝
```

---

## 九、多 Agent 协同模型

MCP 无状态，所有状态存储于平台。Agent 地位平等，无角色绑定。

**规则：**

1. 任何 Agent 可修、审、合
2. 合并前需满足两层门禁：事实层聚合 `success` + 审查意见不为空
3. 审查意见 `neutral` 需 `acknowledge=true`
4. 谁修好谁调 `set_conclusion` 出报告

**审查者指派机制：**

Agent A 提交代码时通过 `commit_and_push(reviewer="张三")` 将审查者标记写入 PR body（`<!-- pr-forge-reviewer: 张三 -->`）。Agent B 调用 `get_review_plan(reviewer="张三")` 即可获取所有需张三处理的 PR 列表。Agent C 调用 `get_review_plan()` 无参得到全部 open PR，各取自己的任务。

`commit_and_push` 推送到非 main 分支时自动检测/创建 PR，Agent 无需手动管理分支或 PR 编号。同一 PR 的后续推送自动更新已有 PR，不产生重复。

---

## 十、`get_review_plan` — MCP 自描述流程

**四种调用方式：**

```
get_review_plan(pr_number=3)                  → 直接按编号查
get_review_plan(branch="codex/fix-bug")       → 按分支名查找对应的 PR
get_review_plan(reviewer="张三")               → 筛选标注为张三处理的全部 open PR
get_review_plan()                             → 返回全部 open PR 列表
```

**动态逻辑（`src/tools/review.js`）：**

`get_review_plan` 每次调用时实时查询各 phase Check Run 当前状态，动态生成步骤清单：

- 各 phase 的 `run_pr_checks` 已执行 → 步骤标 `[completed]`，跳过
- `set_conclusion` 已调用 → 步骤标 `[completed]`，跳过
- 某 phase Check Run 不存在 → 步骤包含该 phase 的 `run_pr_checks`
- 无 `config.json` → `prerequisites.config_exists = false`
- `merge_pr` 仅在所有 phase 聚合为 `success` + conclusion 完成时出现在步骤末尾（`merge_ready = true`）
- `platform` 为 null → 返回 `blocker: 'platform_not_available'`

**无参数 / reviewer 参数：**

```
无参数：
1. 调 platform.listPRs('open') 获取全部 open PR
2. 没有 open PR → 返回 { prs: [], count: 0 }

有 reviewer 参数：
1. 调 platform.listPRs('open') 获取全部 open PR
2. 逐 PR 读取 body，匹配 <!-- pr-forge-reviewer: {reviewer} --> 标记
3. 无匹配 → 返回 { prs: [], count: 0, message: "没有需要 {reviewer} 处理的 PR" }
4. 有匹配 → 返回筛选后的 PR 列表

返回格式升级为列表：
{ ok: true, prs: [{ pr, phases, conclusion_status, merge_ready, next_action, next_params }], count: N }
```

---

## 十一、`pr-forge init` — 一键接入

**实现文件：** `src/cli-init.js`（命令层）+ `src/init.js`（逻辑层）

```
$ npx pr-forge init

  pr-forge v3.0 初始化
  ✓ 检测到项目类型: Node.js
    默认验证阶段:
      - verify: npm run lint && npm test
  ✓ 检测到已有 token (~/.pr-forge/credentials)，直接复用
  ✓ .pr-forge/config.json 已生成（含 .approved hash）
  ✓ .claude/mcp.json 已生成
  ✓ ~/.codex/.mcp.json 已生成
  ⚠️  mcp.json 已加入 .gitignore，不要手动取消。
  ✓ 初始化完成！
```

**项目检测与默认 phases 配置**（`src/init.js` — `PROJECT_DETECTORS`，按顺序匹配）：

| 检测到 | 识别为 | 默认 phases |
|--------|--------|-----------|
| `pom.xml` + `mvnw` | Java (Maven Wrapper) | `[{ "id": "verify", "name": "验证", "check": "./mvnw compile -q && ./mvnw test" }]` |
| `pom.xml` | Java (Maven) | `[{ "id": "verify", "name": "验证", "check": "mvn compile -q && mvn test" }]` |
| `build.gradle` + `gradlew` | Java (Gradle Wrapper) | `[{ "id": "verify", "name": "验证", "check": "./gradlew check" }]` |
| `build.gradle` | Java (Gradle) | `[{ "id": "verify", "name": "验证", "check": "gradle check" }]` |
| `package.json` | Node.js | `[{ "id": "verify", "name": "验证", "check": "npm run lint && npm test" }]` |
| `Cargo.toml` | Rust | `[{ "id": "verify", "name": "验证", "check": "cargo test && cargo clippy" }]` |
| `go.mod` | Go | `[{ "id": "verify", "name": "验证", "check": "go vet ./... && go test ./..." }]` |
| `pyproject.toml` | Python | `[{ "id": "verify", "name": "验证", "check": "pytest -q && ruff check ." }]` |
| 未检测到 | 通用模板 | phases 为空数组，提示用户手动编辑 |

> **多语言项目：** 第一个匹配到的项目类型决定默认 `phases`。如果同时检测到多个，`init` 输出警告："检测到多种项目类型（{TYPES}），已默认选择 {FIRST}。monorepo 项目请手动编辑 .pr-forge/config.json。"

**Token 处理：**
- 优先级：已有 `~/.pr-forge/credentials` > `--token=` 参数 > 交互式输入
- `saveCredentials()` 写入 `~/.pr-forge/credentials`（dir: `0o700`, file: `0o600`）
- `generateMcpJson()` 写入 `.claude/mcp.json`，同时将 `.claude/mcp.json` 追加到 `.gitignore`

**v2 检测：** `checkV2Install()` 检查 `mcp-server/pr-forge/server.py` 是否存在，输出迁移提示。

### GitHub App 凭据复用

`pr-forge auth` 首次运行时创建 GitHub App。后续运行检测 `~/.pr-forge/credentials` 中已有 `appId` + `privateKey` 时：

1. 用 JWT 调 `GET /app` 验证 App 是否存在
2. 存在 → 直接复用，跳过 Manifest Flow，只更新 mcp.json / .codex .mcp.json
3. 不存在 → 提示「已有凭证无效（App 可能已被删除）」→ 进入 Manifest Flow 创建新 App

运行时（MCP 工具）每次 `resolvePlatform()` 同样调 `validateApp(jwt)` 校验 App 死活。App 已删除则返回 `null`，工具统一报 `AUTH_REQUIRED`，引导用户重新 `pr-forge auth`。

`validateApp` 函数在 `src/platforms/github.js` 中实现，`createAppJWT()` 完成后直接 `GET /app`，不需要 installation token。

### `pr-forge doctor` — 环境诊断

**实现文件：** `src/cli-doctor.js`（命令层）+ `src/doctor.js`（逻辑层）

检查 6 项：

| 检查 | 逻辑 |
|------|------|
| Node.js 版本 ≥ 20 | `parseInt(process.version.split('.')[0]) >= 20` |
| config.json 存在且 hash 校验通过 | `fs.existsSync(configPath) && fs.existsSync(approvedPath)` |
| ~/.pr-forge/credentials 可读 | `fs.existsSync(credPath)` |
| git 环境正常 | `git --version` + `git rev-parse --show-toplevel` |
| 平台 API token 有效 | `platform.getUser()` |
| npm 注册状态 | `npm view pr-forge version` (timeout: 5s) |

---

## 十二、v2 → v3 迁移策略

### 数据迁移（`src/tools/review.js` — `tryV2Compat()`）

v2 审查结果存储在 PR comments 中（`<!-- review-phase: N -->` + `<!-- review-commit: SHA -->` marker）。v3 切换到 Check Run / Commit Status 后，已有审查结果不可见。

**策略：向后兼容读取。**

1. `get_review_status` 优先读 Check Run / Commit Status
2. Check Run 不存在（`all.length === 0`）时，降级搜索 PR comments 中的 v2 marker
3. 如果找到 v2 marker（phase 3）且 SHA 匹配当前 PR head，返回 v2 审查结果（标记 `source: "v2_compat"`）
4. 如果找到但 SHA 不匹配，返回 `expired`
5. 如果都找不到，返回"未开始审查"

`merge_pr` 同样包含 v2 compat 路径：Check Run 为空时调 `get_review_status` 检查 v2 兼容结果。

### v2 marker 格式

- `<!-- review-phase: 3 -->` — 阶段编号（v2 的 phase 3 为最终审查）
- `<!-- review-commit: SHA -->` — 审查时的 commit SHA
- `<!-- pr-forge-conclusion: success|failure -->` — 审查结论

---

## 十三、分发方式

pr-forge 发布到 npm（`npm publish`），用户通过 `npx pr-forge init` 零安装接入。

### CI/CD（`.github/workflows/publish.yml`）

- `on: push: tags: ['v*']` 触发
- `runs-on: ubuntu-latest`, `node-version: 22`
- 步骤：`actions/checkout@v4` → `actions/setup-node@v4` → `node --test` → `npm publish`
- `NODE_AUTH_TOKEN` from `secrets.NPM_TOKEN`

---

## 十四、并发控制

`src/lock.js` 实现文件锁机制：

- **锁路径：** `.pr-forge/locks/pr-{n}.lock`
- **获取锁：** `acquireLock()` → `fs.writeFileSync(lp, PID, { flag: 'wx' })` 排他创建
  - `EEXIST` → 读取锁文件中 PID → `process.kill(pid, 0)` 验活
  - 进程已死 → `fs.unlinkSync(lp)` 清理死锁 → 递归重试
  - 进程存活 → 返回 `false`
- **释放锁：** `releaseLock()` → `fs.unlinkSync(lp)`（文件不存在时不报错）
- **调用方：** `run_pr_checks` 在执行前 `acquireLock()`，在 `finally` 块中 `releaseLock()`

---

## 十五、错误码规范

`src/error-codes.js` 定义 24 个错误码，统一结构 `{ code, message, recovery }`。

`error(code, context?)` 工厂函数返回 `{ ok: false, error: { code, message, recovery, context? } }`。

`isRetryable(code)` 判断 `NETWORK_ERROR`、`LOCKED`、`TIMEOUT`、`RATE_LIMITED` 为可重试错误。

| 分类 | 错误码 | message | recovery |
|------|--------|---------|----------|
| 认证 | `AUTH_REQUIRED` | Token 无效或未配置 | 运行 pr-forge init 重新配置 token |
| 资源 | `PR_NOT_FOUND` | PR 不存在 | 确认 PR 编号正确 |
| 资源 | `NO_PULL_REQUEST` | 没有 open PR | 先创建 PR 或使用 pr_number 参数 |
| 文件 | `FILE_NOT_FOUND` | 文件不存在 | 确认文件路径和 ref 参数 |
| 配置 | `NO_CONFIG` | .pr-forge/config.json 不存在 | 运行 pr-forge init 初始化 |
| 配置 | `CONFIG_MODIFIED` | config.json 已被修改（hash 不匹配） | 确认后重新运行 pr-forge init |
| 配置 | `NO_CHECK_COMMAND` | check 字段为空 | 编辑 config.json 填写 check 命令 |
| 网络 | `NETWORK_ERROR` | API 网络错误 | 检查网络连接 |
| 网络 | `RATE_LIMITED` | API 频率限制 | 等待 {retry_after} 秒后重试 |
| Git | `GIT_ERROR` | git 命令执行失败 | 检查工作区状态和远程仓库配置 |
| Git | `DIRTY_WORKTREE` | 工作区有未提交的修改 | git stash 或 git commit |
| Git | `BRANCH_MISMATCH` | branch 与 PR head_ref 不匹配 | 确认分支名或改用 pr_number |
| Git | `NO_CHANGES` | 没有需要提交的修改 | 确认修改已保存 |
| Git | `GIT_IDENTITY_MISSING` | git user.name/email 未配置 | 配置 git 身份信息 |
| 审查 | `MERGE_NOT_ALLOWED` | 审查未完成，禁止合并 | 先 run_pr_checks → set_conclusion |
| 审查 | `MERGE_CONFLICT` | 合并冲突 | 手动解决冲突后再合并 |
| 审查 | `SHA_MISMATCH` | body SHA 与参数 SHA 不匹配 | 确认传入 SHA 与 PR head SHA 一致 |
| 审查 | `REVIEW_STALE` | 审查结果已过时（PR 可能被 force-push） | 重新 run_pr_checks |
| 审查 | `CODE_UPDATED_DURING` | 执行期间代码被更新 | 重新 run_pr_checks |
| 并发 | `LOCKED` | 并发锁被占用 | 等待 1-2 分钟后重试，或手动删除 lock 文件 |
| 参数 | `INVALID_VERDICT` | verdict 值不合法 | 只能为 success、failure 或 neutral |
| 参数 | `INVALID_PATH` | 路径包含非法字符 | 使用合法文件路径，不含 ../ 等 |
| 超时 | `TIMEOUT` | 执行超时 | 增加 config.json 中 timeout 值 |
| 验证 | `CHECK_FAILED` | 验证不通过（非零退出） | 查看 Check Run 输出中的具体错误信息 |

---

## 十六、测试策略

`package.json` 中未定义 test script，`publish.yml` 中调用 `node --test`（Node 20+ 内置测试运行器）。

| 层级 | 范围 |
|------|------|
| 单元测试 | 平台 API mock：GitHub/Gitee API 请求/响应对 |
| 单元测试 | 安全校验：`config.json` hash 校验 + `.approved` 比对 |
| 单元测试 | 文件锁：排他创建、PID 检测、死锁恢复、并发争用 |
| 集成测试 | `run_pr_checks`：git checkout → 执行 phases → 切回原分支 → 锁释放 |
| 集成测试 | `commit_and_push`：git add → commit → push 完整链路 |
| 集成测试 | v2 兼容读取：从 PR comment marker 解析审查结果 |
| E2E | 真实 PR 上完整流程：`get_review_plan` → `run_pr_checks` → `set_conclusion` → `merge_pr` |

---

## 十七、实现状态

### 已完成

- [x] MCP JSON-RPC server（`src/server.js`）
- [x] 9 个 MCP 工具全部实现
- [x] GitHub 平台适配（`src/platforms/github.js`）
- [x] Gitee 平台适配（`src/platforms/gitee.js`）
- [x] 平台路由检测（`src/platforms/router.js`）
- [x] `pr-forge init` 命令（`src/cli-init.js` + `src/init.js`）
- [x] `pr-forge auth` 命令（`src/cli-auth.js` — GitHub App Manifest Flow）
- [x] `pr-forge doctor` 命令（`src/cli-doctor.js` + `src/doctor.js`）
- [x] CLI 四模式入口（`src/cli.js`）
- [x] config.json 防篡改 hash 校验（`src/config.js`）
- [x] 文件锁并发控制 + 死锁恢复（`src/lock.js`）
- [x] 24 个统一错误码 + recovery 建议（`src/error-codes.js`）
- [x] v2 向后兼容读取（`tryV2Compat()`）
- [x] CI/CD pipeline（`.github/workflows/publish.yml`）
- [x] Token 安全存储（`~/.pr-forge/credentials` 0o600 + `.gitignore`）
- [x] 8 种项目类型自动检测（`PROJECT_DETECTORS`）
- [x] `get_review_plan` 无参数返回全部 open PR + reviewer 过滤
- [x] `commit_and_push` branch 可选（默认当前分支）+ 自动检测/创建 PR
- [x] `commit_and_push` 返回 `pr_number` + 支持 `reviewer`/`title` 参数
- [x] `get_review_plan` / `get_review_status` 支持 `branch` 参数反查 PR
- [x] `init` 同时生成 Claude（.claude/mcp.json）和 Codex（~/.codex/.mcp.json）配置
- [x] `set_conclusion` 更新已有结论时校验 SHA 防过期
- [x] `pr-forge auth` 凭据复用：已有有效 App 时跳过 Manifest Flow
- [x] `validateApp` 运行时校验：每次 `resolvePlatform` 验证 App 是否存活
- [x] `hasCodeChanges()` 修复：空 diff 时回退运行检查（不再误判为 doc-only）
- [x] ESLint lint + `node --test` test 脚本（`package.json`）
- [x]   纯文档变更跳过 Check Run（`src/tools/checks.js` — `hasCodeChanges()`）

### 未完成 / 后续迭代

- [ ] 单元测试 + 集成测试（`publish.yml` 中的 `node --test` 目前无测试文件，`npm test` 目前也是 `node --test`）
- [ ] TypeScript 类型声明
- [ ] `docs/getting-started.md` 入门教程
- [ ] API reference 文档
- [ ] 审查报告超长截断的验证测试
- [ ] Gitee Commit Status force-push 过时检测测试
- [ ] GiteePlatform 增加 `listReviews` 方法 (目前仅 GitHub 支持)

### 不在范围内

- Web dashboard
- 自定义审查策略 DSL
- GitLab/Bitbucket 平台支持
- 内置 prompt templates
- DX 测量 dashboard

---

## 十八、GitHub App 认证

### 背景

GitHub Check Runs API 要求使用 GitHub App installation token（`ghs_` 前缀），经典 PAT（`gho_`/`ghp_`）调用 Check Runs API 返回 403 `You must authenticate via a GitHub App`。因此 pr-forge 需要支持 GitHub App 认证以正常使用 Check Run 功能。

### 认证机制

**JWT 签发**（`createAppJWT`, `src/platforms/github.js`）：

- 使用 `node:crypto` 内置模块零依赖实现 RS256 JWT 签名
- Header: `{ alg: 'RS256', typ: 'JWT' }`
- Payload: `{ iat: now-60s, exp: now+600s, iss: App ID }`
- 签名：`crypto.sign('RSA-SHA256', signingInput, privateKey)`

**Installation Token 交换**（`getInstallationToken`, `src/platforms/github.js`）：

- 若已记录 `installationId`：直接 `POST /app/installations/{id}/access_tokens` 换 token
- 若未记录：先 `GET /app/installations` 列出所有安装，按 owner 匹配 → 获取 installation ID → 换 token
- 返回 `ghs_` 前缀的 installation access token（有效期 1 小时）

### Token 获取优先级

`context.js:getToken(env)` 按以下优先级获取 token：

1. GitHub App env vars（`PR_FORGE_GITHUB_APP_ID` + `PR_FORGE_GITHUB_APP_PRIVATE_KEY`，来自 `mcp.json`）
2. PAT env var（`PR_FORGE_TOKEN` / `GITHUB_TOKEN` / `GITEE_TOKEN`）
3. `~/.pr-forge/credentials` — GitHub App 凭据（`appId` + `privateKey`）
4. `~/.pr-forge/credentials` — PAT（`token`）

### 凭据存储格式

`~/.pr-forge/credentials`（JSON, `0o600`）：

```json
// PAT 模式
{ "token": "gho_xxx", "created_at": "..." }

// GitHub App 模式
{ "appId": 123456, "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...", "installationId": 98765432, "created_at": "..." }
```

### mcp.json 生成

`init.js:generateMcpJson()` 根据凭据类型生成对应的 env：

- **PAT 模式**：`"env": { "PR_FORGE_TOKEN": "gho_xxx" }`
- **GitHub App 模式**：`"env": { "PR_FORGE_GITHUB_APP_ID": "123456", "PR_FORGE_GITHUB_APP_PRIVATE_KEY": "-----BEGIN RSA...", "PR_FORGE_GITHUB_APP_INSTALLATION_ID": "98765432" }`

### resolvePlatform 异步化

`context.js:resolvePlatform()` 改为 `async` 函数。检测到 App 凭据时，自动调用 `createAppJWT()` → `getInstallationToken()` 生成 `ghs_` token，再创建平台实例。

`server.js:PrFlowServer` 配合改动：
- `constructor` 中不再同步初始化 `this.platform`
- 新增 `async resolvePlatform()` 惰性初始化方法
- `handleToolCall` 中先 `await this.resolvePlatform()` 获取平台实例

### 用户配置流程

**GitHub App 模式（Manifest Flow）**（`src/cli-auth.js`）：

```
$ pr-forge auth

pr-forge GitHub App 授权 (Manifest Flow)

✓ 检测到仓库: owner/repo
→ 正在打开浏览器...
→ 等待用户授权...

→ 正在交换授权码...

✓ App ID: 123456
✓ 凭据已保存到 ~/.pr-forge/credentials
✓ .claude/mcp.json 已更新

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ GitHub App 授权完成！

  浏览器将自动跳转到安装页面，选择仓库后点击 Install 即可。
  安装地址: https://github.com/settings/apps/pr-forge-wang654993222/installations
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Manifest Flow 实现细节：**

1. 检测当前仓库（`git config --get remote.origin.url`），解析 owner/repo，生成含 owner 的 App 名（如 `pr-forge-wang654993222`）
2. 构建 GitHub App manifest JSON（预填权限：checks:write, pull_requests:write, contents:read, metadata:read），`redirect_url` 指向本地回调
3. 在随机端口（`localhost`）启动本地 HTTP 服务器，两路由：
   - `/` → 展示 landing page（HTML 页面含 manifest JSON 预览 + POST 表单，用户点击按钮手动提交）
   - `/callback` → 接收 GitHub 重定向（带 `code` + `state`）
4. 生成随机 `state` 参数（`crypto.randomBytes(16)`）防 CSRF
5. 打开浏览器到 `http://localhost:{port}/`，用户看到配置预览后点击按钮 → POST 表单到 `https://github.com/settings/apps/new`
6. GitHub 渲染 App 创建确认页（manifest 全部预填），用户点击 **Create GitHub App**
7. GitHub 重定向到本地 `http://localhost:{port}/callback?code=...&state=...`
8. 校验 `state` 一致 → 用 `code` 交换 `POST /app-manifests/{code}/conversions` → 获得 `appId` + `pem` + `slug`
9. 保存 `{ appId, privateKey }` 到 `~/.pr-forge/credentials`，重新生成 `.claude/mcp.json`
10. 浏览器 1.5 秒后自动跳转到 `https://github.com/settings/apps/{slug}/installations`，用户选择仓库点击 Install 完成安装

**安全措施：**
- `state` 参数防 CSRF（256-bit 随机值）
- 回调服务器仅监听 `localhost`，外部不可达
- 2 分钟超时自动关闭服务器
- 交换 manifest code 失败 → 浏览器显示错误，服务器关闭
- Marketplace 相关错误 → 中文提示引导用户接受协议

**PAT 模式（不变）：**

```
$ npx pr-forge init
  → 粘贴 gho_/ghp_ token
  → 写入 ~/.pr-forge/credentials
  → 写入 .claude/mcp.json (env: PR_FORGE_TOKEN)
```

---

**VERDICT:** 核心功能全部实现，ready for use。测试覆盖和文档补齐为后续迭代任务。
