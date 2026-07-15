<!-- /autoplan restore point: /Users/wangchenglong/.gstack/projects/hsoft-data-manage/main-autoplan-restore-20260715-092347.md -->

# pr-flow v3.0 架构方案

> AI 代码变更安全网关 — Agent 修改代码必须走 PR 审查，验证通过后方可合并。任何 Agent 平等协作，不绑角色。

---

## 一、语言迁移：Python → Node.js

**决策：** 从 Python 迁移到 Node.js，零 npm 依赖。

**理由：**

- 目标用户（Claude Code / Codex / Cursor 使用者）已预装 Node.js
- Python 是额外依赖，每多一步就流失一批用户
- `requests` → `fetch`（Node 20+ 内置）、`subprocess` → `child_process`
- 通过 `npx pr-flow` 实现零安装运行（备选包名 `pr-forge`）

**v2 兼容：** v2 Python 版保留但标记 EOL。`server.py` 改为代理——输出迁移提示 "pr-flow v2 is EOL, run `npx pr-flow init` to migrate"，不报错，给已有用户平滑过渡期。

---

## 二、项目结构

```
pr-flow/
├── package.json
├── README.md
├── src/
│   ├── server.js          # MCP + init 双模式
│   ├── init.js            # pr-flow init 命令
│   ├── tools/
│   │   ├── review-plan.js # get_review_plan
│   │   ├── checks.js      # run_pr_checks
│   │   ├── conclusion.js  # set_conclusion
│   │   ├── code.js        # get_pr_diff / get_file_content
│   │   ├── git.js         # commit_and_push / merge_pr
│   │   └── context.js     # get_pr_context / get_review_status
│   └── platforms/
│       ├── github.js      # GitHub API + Check Runs
│       └── gitee.js       # Gitee API + Commit Status
└── test/
```

**唯一依赖：** Node.js 20+

---

## 三、安全模型

### config.json 防篡改

`run_pr_checks` 执行任意 shell 命令。为防止 Agent 或恶意修改篡改 `config.json`：

1. `init` 生成 `config.json` 时计算 SHA256 hash，存入 `.pr-flow/.approved`
2. `run_pr_checks` 每次执行前对比 `config.json` 的当前 hash 与 `.approved` 中记录
3. hash 一致 → 正常执行
4. hash 不一致 → 拒绝执行，返回 "config.json 已被修改，请确认后重新运行 `pr-flow init`"

> **安全边界：** 此校验防御的是 Agent 或用户无意中修改 `config.json` 导致后续 `run_pr_checks` 执行意外命令的场景。任何有文件系统写权限的进程都可以同时修改 `config.json` 和 `.approved` 来绕过校验，因此这不是对抗恶意篡改的机制。对于恶意修改，信任边界应建立在平台侧（Check Run 状态 + 分支保护规则）。
> 
> **已知攻击场景：** 攻击者通过文件系统写权限同时篡改 `config.json` 和 `.approved` → 可注入任意 shell 命令。攻击前提是已获得本地文件系统写权限，在该前提下 pr-flow 不是唯一被攻击的目标（`mcp.json`、`~/.pr-flow/credentials` 也同样暴露）。信任边界应建立在平台侧：分支保护规则 + Check Run 状态审计。

### Token 存储

Token 需要在 `mcp.json` 的 env 字段中供运行时读取，但必须防止误提交到仓库：

- Token 写入 `.claude/mcp.json` 的 env 字段（Claude Code/Codex 运行时读取）
- `init` 自动将 `.claude/mcp.json` 加入项目的 `.gitignore`
- Token 同时备份到 `~/.pr-flow/credentials`（跨项目复用 + 防止误删后丢失）
- `pr-flow init` 检测到 `~/.pr-flow/credentials` 已有 token → 直接复用，不再询问
- `init` 输出红色警告："mcp.json 已加入 .gitignore，不要手动取消。Token 已备份到 ~/.pr-flow/credentials"

---

## 四、MCP 工具清单（v3.0，共 9 个）

| # | 工具 | 参数 | 功能 |
|---|------|------|------|
| 1 | `get_pr_context` | `pr_number` | PR 元数据（title/state/draft/SHA/branch/author） |
| 2 | `get_review_status` | `pr_number` | 读各 phase Check Run 结论 + 完整审查报告（含聚合状态）。拉取 Check Run 时校验其关联 SHA 与 PR 当前 head SHA 是否一致，不一致标记为 `stale` |
| 3 | `get_pr_diff` | `pr_number`, `max_bytes?` | 获取 PR unified diff |
| 4 | `get_file_content` | `path`, `ref?` | 获取仓库文件内容 |
| 5 | `commit_and_push` | `message`, `pr_number` 或 `branch`, `files?` | 提交修复并推送（pr_number 和 branch 二选一必传） |
| 6 | `merge_pr` | `pr_number`, `merge_method?`, `acknowledge?` | 合并 PR（两层门禁：事实层聚合 + 审查意见）。`acknowledge` 默认 `false`，审查意见 `neutral` 时必须传 `acknowledge=true` |
| 7 | `run_pr_checks` | `pr_number`, `phase?`, `timeout?` | 执行 config.json 的 check 命令（多阶段），各 phase 独立写 Check Run |
| 8 | `set_conclusion` | `pr_number`, `conclusion`, `report_text?` | 修改 Check Run 整体结论，附带审查报告 |
| 9 | `get_review_plan` | `pr_number?`, `branch?` | 动态生成审查步骤清单（无参数自动找最新 open PR，branch 通过 API head 过滤查找） |

> **v2 能力去留决策：** PR comment API（`list_comments`/`create_comment`/`update_comment`）和 PR Review API（`create_review`）被 Check Run output 取代，不再作为独立工具。如有强需求可后续加回。

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

`next_action` 是 Agent 下一步该调的工具名，`next_params` 是调用参数。Agent 不需要推理，拿起来就用。`prerequisites` 让首次调用就能告诉 Agent "config.json 不存在，先让用户 `pr-flow init`"。

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
  "conclusion": { "conclusion": "neutral", "report_sha": "abc123", "author": "codex" },
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
  "next_suggestion": "修复 test phase 的 2 个失败用例后，重跑 run_pr_checks(phase='test')"
}
```

错误时统一返回：

```json
{
  "ok": false,
  "error": {
    "code": "LOCKED",
    "message": "并发锁被占用，另一个 run_pr_checks 正在同一 PR 上执行",
    "recovery": "等待当前执行完成（锁文件会在执行结束后自动释放），1-2 分钟后重试。如确认没有并发执行，可手动删除 .pr-flow/locks/pr-{n}.lock",
    "context": { "lock_file": ".pr-flow/locks/pr-42.lock", "pid": 12345 }
  }
}
```

`context` 为可选的具体上下文（锁文件路径、死锁 PID 等），Agent 在 recovery 指令中能用到这些值。

---

## 五、`run_pr_checks` — 配置文件驱动的多阶段验证

**约定：** 项目根目录 `.pr-flow/config.json`：

```json
{
  "version": "3.0",
  "timeout": 300,
  "phases": [
    { "id": "lint",  "name": "代码检查", "check": "npm run lint", "timeout": 60 },
    { "id": "test",  "name": "单元测试", "check": "npm test", "timeout": 600 },
    { "id": "audit", "name": "安全审计", "check": "npm audit --audit-level=high" }
  ]
}
```

`phase.timeout` 覆盖全局 `timeout` 值，不设则继承。`phases` 为数组，按顺序执行。每个 phase 有唯一 `id`、显示用的 `name` 和要执行的 `check` 命令。向后兼容：如果只有 `check` 字段（无 `phases`），视为单阶段 `[{ "id": "default", "name": "验证", "check": "..." }]`。每个 phase 有唯一 `id`、显示用的 `name` 和要执行的 `check` 命令。向后兼容：如果只有 `check` 字段（无 `phases`），视为单阶段 `[{ "id": "default", "name": "验证", "check": "..." }]`。

`version` 字段由 `init` 自动写入，未来 schema 升级时 `init` 通过版本号判断是否需要迁移配置。用户不应手动修改此字段。

**工具签名：**

`run_pr_checks(pr_number, phase?)` — 不传 `phase` 则执行所有阶段；传 `phase`（phase id）则只执行指定阶段。

**执行方式：**

`run_pr_checks` 内部使用 Node `execSync(config.check, { shell: true })`。

**工具行为：**

1. 安全校验：对比 `.pr-flow/config.json` hash 与 `.pr-flow/.approved`（见第三节）
2. git status 预检：`git status --porcelain` 确认工作区干净，有未提交修改则返回 `DIRTY_WORKTREE`
3. 并发控制：获取文件锁 `.pr-flow/locks/pr-{n}.lock`（`fs.open(path, 'wx')` 排他创建 + PID 写入），已被占用则检查 PID 是否存活（`process.kill(pid, 0)`），进程已死则清理死锁并重试，存活则返回 `LOCKED`
4. 记录原分支 HEAD SHA：`ORIG_SHA=$(git rev-parse HEAD)`
5. 记录 PR 当前 head SHA（从 `get_pr_context` 获取）
6. `git fetch origin pull/{pr}/head:pr-{pr}`
7. `git checkout pr-{pr}`
8. 按顺序执行 phases，每个 phase 独立记录 exit code / stdout / stderr。**check 命令应为只读操作（lint/test/vet），不应修改代码**
9. 执行后校验 PR head SHA 是否变化（防止并发 push），变化则在结果中标注 `code_updated_during_check`
10. 切回原分支：`git checkout $ORIG_SHA`（使用 SHA 而非分支名，避免原分支被删除后停留异常状态），释放锁（删除 lock 文件）
11. 每个 phase 结果独立写入 Check Run / Commit Status，Check Run name 为 `pr-flow/{phase-id}`（例如 `pr-flow/lint`、`pr-flow/test`）

**两层结论模型（事实层 + 审查意见层）：**

v3 有两层结论，分别存储在不同 Check Run 中：

| 层 | 写工具 | Check Run name | 含义 |
|---|--------|---------------|------|
| 事实层 | `run_pr_checks` | `pr-flow/{phase-id}` | 各 phase 验证结果（自动化） |
| 审查意见层 | `set_conclusion` | `pr-flow/conclusion` | 审查 Agent 的最终判定（人工/AI 判断） |

**Check Run 命名约定：**

- 事实层：`pr-flow/{phase-id}` — 由 `config.json` 中每个 phase 的 `id` 决定。`get_review_status` 通过 `check_name` 过滤精确拉取各 phase 状态
- 审查意见层：`pr-flow/conclusion` — `set_conclusion` 写入，`merge_pr` 读取
- 多 Agent 协作不会产生同名冲突，因为每个 phase.id 在 `config.json` 中唯一

**事实层聚合规则**（`run_pr_checks` 各 phase 独立 Check Run 的 AND 聚合）：
- 所有 phase 均为 `success` → 验证通过
- 任一 phase 为 `failure` → 验证不通过
- 任一 phase 为 `neutral` 且无 `failure` → 验证带风险

**`merge_pr` 决策逻辑**（两层 AND）：
1. 事实层聚合 → `failure`：永远拒绝合并（验证未过）
2. 事实层聚合 → `success`，审查意见层 → `success`：合并
3. 事实层聚合 → `success`，审查意见层 → `neutral`：需 `acknowledge=true` 确认
4. 审查意见层 → 不存在：拒绝，"审查未完成，请调 set_conclusion"
5. 事实层 Check Run 不存在：拒绝，"未执行 run_pr_checks，禁止合并"

`set_conclusion` 不覆盖各 phase 的独立 Check Run——它是独立的审查意见，`merge_pr` 以"事实层 AND 审查意见层"为最终门禁。

**异常处理：**

| 情况 | 返回 |
|------|------|
| `config.json` 不存在 | `NO_CONFIG` |
| `config.json` hash 不匹配 | `CONFIG_MODIFIED`，提示重跑 init |
| 工作区不干净 | `DIRTY_WORKTREE`，提示先提交或暂存 |
| 并发锁被占用 | `LOCKED`，提示稍后重试 |
| `check` 字段为空 | `NO_CHECK_COMMAND` |
| 执行超时 | `TIMEOUT` + 已捕获输出 |
| 非零退出 | `CHECK_FAILED` + 完整输出 |
| git checkout 失败 | `GIT_ERROR` |

---

## 六、平台适配

### GitHub（Check Runs）

| 能力 | 实现 |
|------|------|
| 验证结果 | Check Runs API |
| 审查报告 | Check Run `output` 字段（title/summary/text） |
| 合并阻断 | 分支保护规则（原生） |
| 三种结论 | `success` / `failure` / `neutral` |
| 报告长度限制 | 65535 字符，超限自动截断并标注 |

### Gitee（Commit Status）

| 能力 | 实现 |
|------|------|
| 验证结果 | Commit Status API |
| 合并阻断 | 仓库设置手动开启 CI 检查 |
| 两种状态 | `success` / `failure` |
| neutral 替代 | `success` 状态 + `merge_pr` 内部拒绝（策略 C） |
| 审查报告 | PR comment（Commit Status 无 output 字段） |

> **注意：** Gitee Commit Status 关联单个 commit SHA，PR force-push 后旧状态可能过时。启动时需检测并重建。

**Gitee 上 `get_review_status` 的数据组装：**

Gitee 平台审查结论和审查报告分属两个数据源（Commit Status + PR comment），`get_review_status` 需要合并查询：

1. 调 Commit Status API 获取当前结论（`success` / `failure`）
2. 调 PR comments API 搜索 `<!-- pr-flow-report: true -->` marker，获取最新审查报告
3. 合并返回统一结构：`{ conclusion, report, source: "commit_status + pr_comment" }`

调用 Agent 对双平台看到的数据结构一致，差异在 `get_review_status` 内部封装。

**结论状态映射：**

| 审查结论 | GitHub | Gitee |
|----------|--------|-------|
| 全过 | Check Run: `success` | Commit Status: `success` |
| 挂了 | Check Run: `failure` | Commit Status: `failure` |
| 通过但有风险 | Check Run: `neutral` | Commit Status: `success` + merge_pr 走 `acknowledge=true` 逻辑 |

### 多账号协作（团队场景）

每个团队成员使用自己的平台 token。状态存储在平台上，与谁的 token 无关。

### Token 权限对照

| 操作 | GitHub（最小权限） | Gitee |
|------|--------------------|-------|
| 读 PR | `repo`（私有）/ `public_repo`（公开） | `pull_requests` |
| Check Run / Commit Status | `repo` / `repo:status` | `projects` |
| 读文件 | `repo` / `public_repo` | `projects` |
| 合并 PR | `repo` | `pull_requests` |

**注意：** `repo` scope 是 full control，权限较大。如果仓库公开，优先使用 `public_repo` + `repo:status` 减少权限暴露面。

---

## 七、合并门禁（`merge_pr` + `set_conclusion`）

**两个工具配合：**

| 工具 | 谁调 | 做什么 |
|------|------|--------|
| `run_pr_checks` | 任何 Agent | 跑验证（可多阶段），各 phase 独立写入 Check Run / Commit Status |
| `set_conclusion` | 审查 Agent | 写审查意见 + 附带审查报告 → 写入 `pr-flow/conclusion` Check Run |
| `merge_pr` | 任何 Agent | 读事实层聚合 + 审查意见层，两层 AND 决策 |

**`merge_pr` 决策逻辑（两层 AND，见第五节两层模型）：**

```
0. 事实层 Check Run 不存在 → 检查 v2 兼容路径（12.5 节），source: "v2_compat" 视为审查已完成。v2 兼容路径返回的审查结果跳过步骤 1 的 SHA 校验（v2 结果在 PR comment 中，无 Check Run SHA 可校验），直接进入合并决策
1. 校验各 phase Check Run + 审查意见 Check Run 的关联 SHA 与 PR 当前 head SHA
   // 任一 phase SHA 不一致即整体拒绝，确保所有验证在同一 commit 上执行
2. SHA 不一致 → 拒绝，"PR 已在审查后被 force-push，请重新 run_pr_checks"
3. 读所有 phase Check Run 按第五节规则聚合
4. 聚合 failure → 拒绝，"验证未通过，先修复"
5. 聚合 success，审查意见不存在 → 拒绝，"审查未完成，请调 set_conclusion"
6. 聚合 success，审查意见 success → 合并
7. 聚合 success，审查意见 neutral → 拒绝，"请 acknowledge=true 确认审查意见中的风险"
```

**`acknowledge` 参数：** `merge_pr` 的 `acknowledge` 参数默认 `false`。当审查意见为 `neutral` 时必须传 `acknowledge=true` 才能合并——表示调用者已阅读并确认接受审查报告中标注的风险。

**Check Run output 长度处理：**

`set_conclusion` 写入 report_text 前检查长度。如果 `output.text` 超过 65535 字符（GitHub 限制），自动截断并追加"报告过长已截断"。如果平台不支持 Check Run output（Gitee），审查报告 fallback 到 PR comment。

**风险等级两级：**

| 等级 | 含义 | 阻断？ |
|------|------|:---:|
| 🟡 标注 | 小问题（命名、注释），记在报告里供参考 | 否 |
| 🟠 风险 | 潜在功能影响、不确定的副作用 | **是**（set_conclusion → neutral） |

---

## 八、多 Agent 协同模型

MCP 无状态，所有状态存储于平台。Agent 地位平等，无角色绑定。

**规则：**

1. 任何 Agent 可修、审、合
2. 合并前需满足两层门禁：事实层聚合 `success` + 审查意见不为空
3. 审查意见 `neutral` 需 `acknowledge=true`
4. 谁修好谁调 `set_conclusion` 出报告

---

## 九、审查报告（存入 Check Run output）

审查报告通过 `set_conclusion` 写入 Check Run 的 `output` 字段。

`set_conclusion` 的 `report_text` 参数为完整 Markdown 字符串，Agent 不需构造嵌套 JSON。

**报告 Markdown 约束：**

```markdown
<!-- pr-flow-report: true -->
<!-- pr-flow-conclusion: {success|neutral|failure} -->

## PR #{n} 审查报告

### 1. 改动摘要
[用自己的话复述，不允许抄 diff]

### 2. 验证结果
- Check Run: ✅ success / ❌ failure / ⚠️ neutral

### 3. 标注与风险
| 文件 | 行号 | 等级 | 说明 |
|------|------|------|------|
| Foo.java | 42 | 🟠 风险 | 跨模块副作用不确定 |
| Bar.java | 15 | 🟡 标注 | 变量名建议更明确 |

### 4. 修改建议
- [文件名]:[行号] — 具体方案

### 5. 结论
- [ ] success / neutral / failure

### 6. 无法修复说明
[如遇无法处理的问题，必须说明原因]
```

**审查规则：**

- 不允许"LGTM"
- check 挂了 → 先修，修不了才 `set_conclusion(failure)`
- 有 🟠 风险 → 必须 `set_conclusion(neutral)`
- 🟡 标注不卡流程，但必须记入报告

---

## 十、`get_review_plan` — MCP 自描述流程

**三种调用方式：**

```
get_review_plan(pr_number=3)                  → 直接按编号查
get_review_plan(branch="codex/fix-bug")       → 按分支名查找对应的 PR
get_review_plan()                             → 自动推断：从 git branch --show-current 匹配 PR
```

**动态逻辑：**

`get_review_plan` 每次调用时读取各 phase Check Run 当前状态，动态生成步骤清单：

- 各 phase 的 `run_pr_checks` 已执行 → 步骤标 `[completed]`，跳过
- `set_conclusion` 已调用 → 步骤标 `[completed]`，跳过
- 某 phase Check Run 不存在 → 步骤包含该 phase 的 `run_pr_checks`
- 无 `config.json` → 验证步骤替换为"人工逐文件检查"
- `merge_pr` 仅在所有 phase 聚合为 `success` 时出现在步骤末尾

**平台降级：**

`get_review_plan` 内部判断平台：GitHub 用 Check Runs API，Gitee 用 Commit Status API + PR comments。Gitee 上如果 Commit Status 为空且无 PR comment marker，视为"未开始审查"。每次调用均实时查询平台 API，不缓存状态。

**`branch` 参数查找实现：**

`get_review_plan(branch="codex/fix-bug")` 通过 `GET /pulls?state=open&head=owner:branch` 查找对应 PR（GitHub/Gitee API 均支持 `head` 过滤参数）。找到唯一匹配则返回审查计划；多个匹配返回列表；无匹配返回 `NO_PULL_REQUEST`。

**无参数自动查找：**

```
1. git branch --show-current 获取当前分支名
2. 用当前分支名通过 GET /pulls?state=open&head=owner:branch 查找匹配的 PR
3. 唯一匹配 → 返回审查计划
4. 无匹配（当前在 main/master 上）→ 回退：查仓库 open PR 列表，按创建时间倒序
5. 有多个 open PR → 按最近更新（`updated_at`）降序排列，返回列表前 5 个，标注最近一个为 `[suggested]`，Agent 可根据上下文自行选择或使用 `pr_number` 参数精确指定
6. 没有      → 返回 "当前没有待审查的 PR"
```

已合并（closed）的 PR 不会出现在查找结果中。

---

## 十一、`pr-flow init` — 一键接入

### 方式一：Agent 自动安装（推荐）

用户只需说一句话、粘贴一次 token，Agent 完成其余：

```
用户: "帮我安装 pr-flow"
Agent:
  → npm i -g pr-flow
  → "需要 GitHub token，去 https://github.com/settings/tokens/new，权限选 repo"
用户: 粘贴 token
Agent:
  → pr-flow init --token ghp_xxx
  → "装好了，重启 Claude Code / Codex"
```

Token 同时写入 mcp.json（运行时）和 ~/.pr-flow/credentials（备份）。mcp.json 自动加入 .gitignore。init 输出红色警告："mcp.json 已加入 .gitignore，不要手动取消"。

### 方式二：手动安装

```
$ npx pr-flow init

  ▸ 检测项目类型...
  ▸ 创建 .pr-flow/config.json + .pr-flow/.approved (hash)
  ▸ GitHub Token → 存到 ~/.pr-flow/credentials
  ▸ 生成 .claude/mcp.json 或更新 config.toml
  ▸ Done!
```

**项目检测与默认 phases 配置：**

| 检测到 | 识别为 | 默认 phases |
|--------|--------|-----------|
| `pom.xml` + `mvnw` | Java (Maven Wrapper) | `[{ "id": "verify", "name": "验证", "check": "./mvnw compile -q && ./mvnw test" }]` |
| `pom.xml` | Java (Maven) | `[{ "id": "verify", "name": "验证", "check": "mvn compile -q && mvn test" }]` |
| `build.gradle` + `gradlew` | Java (Gradle Wrapper) | `[{ "id": "verify", "name": "验证", "check": "./gradlew check" }]` |
| `build.gradle` | Java (Gradle) | `[{ "id": "verify", "name": "验证", "check": "gradle check" }]` |
| `package.json` | Node.js | `[{ "id": "verify", "name": "验证", "check": "npm run lint && npm test" }]` |
| `Cargo.toml` | Rust | `[{ "id": "verify", "name": "验证", "check": "cargo test && cargo clippy" }]` |
| `go.mod` | Go | `[{ "id": "verify", "name": "验证", "check": "go vet ./... && go test ./... }]` |
| `pyproject.toml` | Python | `[{ "id": "verify", "name": "验证", "check": "pytest -q && ruff check ." }]` |
| 未检测到 | 通用模板 | 提示用户自己填 |

> **多语言项目：** 检测按上表顺序进行，仅扫描项目根目录。第一个匹配到的项目类型决定默认 `phases`。如果同时检测到多个项目类型（如 `pom.xml` + `package.json`），`init` 输出警告："检测到多种项目类型（{TYPE1}, {TYPE2}），已默认选择 {DEFAULT}。monorepo 项目请手动编辑 .pr-flow/config.json。"

### `pr-flow doctor` — 环境诊断

`pr-flow doctor` 检查以下项目并逐项报告通过/失败：

- Node.js 版本 ≥ 20
- `.pr-flow/config.json` 存在且 hash 校验通过
- `~/.pr-flow/credentials` 可读
- git 环境正常（`git --version`、当前目录是 git 仓库）
- 平台 API token 有效（调一次 `GET /user` 验证）
- npm 注册状态（`npm view pr-flow`）

Agent 可以使用 `pr-flow doctor` 作为首次调用的前置检查，或排查用户报告的安装问题。

### 完整首次体验

从用户视角，一次完整的 pr-flow 接入到首次合并的路径：

1. 用户: "帮我装 pr-flow" → Agent 执行 `npm i -g pr-flow && pr-flow init`
2. `init` 输出: `现在可以了，告诉你的 Agent: "审查 PR #3"`
3. 用户创建 PR 后，审查 Agent 调 `get_review_plan` → 发现 config.json 已配置 → 返回 `next_action: "run_pr_checks"`
4. Agent 调 `run_pr_checks(pr_number=3)` → 三个 phase 全绿 → Check Run 全部 success
5. Agent 调 `set_conclusion(pr_number=3, conclusion="success", report_text="...")`
6. Agent 调 `merge_pr(pr_number=3)` → 两层门禁全过 → 合并成功

从用户视角：装了一次，之后 Agent 自己走完全程。用户回头看 PR 页面，发现已 merged，Check Run 全绿。这不是设计规范，是体验基准——实现时每个工具的行为都需要通过这个场景验证。

---

## 十二、接入路径对比

| | v2.x（Python） | v3.0（Node） |
|---|---|---|
| 步骤 | 6 步手动 | 3 步（2 步自动） |
| 依赖 | Python 3.9+ + pip install requests | 无 |
| 配置 | 手写 mcp.json | init 自动生成 |
| 验证命令 | 手写 check.sh | 自动检测生成 config.json |
| 审查流程 | Phase 1/2/3 多阶段 | 多阶段 check + Check Run 聚合 |
| Windows | 需 WSL | 原生（execSync shell:true） |
| 审查报告 | PR comment | GitHub: Check Run output；Gitee: PR comment（`get_review_status` 内部封装差异） |
| Token 安全 | mcp.json 明文 | ~/.pr-flow/credentials + hash 校验 |
| 并发安全 | 无 | 文件锁 |

---

## 十二点五、v2 → v3 迁移策略

### 数据迁移

v2 审查结果存储在 PR comments 中（`<!-- review-phase: N -->` + `<!-- review-commit: SHA -->` marker）。v3 切换到 Check Run / Commit Status 后，已有审查结果不可见。

**策略：向后兼容读取。**

1. `get_review_status` 优先读 Check Run / Commit Status
2. Check Run 不存在时，降级搜索 PR comments 中的 v2 marker（`<!-- review-phase: 3 -->` + `<!-- review-commit: SHA -->`）
3. 如果找到 v2 marker 且 SHA 匹配当前 PR head，返回 v2 审查结果（标记 `source: "v2_compat"`）
4. 如果找到但 SHA 不匹配，返回 `expired`（同 v2 行为）
5. 如果都找不到，返回"未开始审查"

这意味着 v3 安装后，已有 v2 PR 的审查结果仍然可读，`merge_pr` 不会因为"Check Run 不存在"而拒绝已有审查的 PR。

### init 检测已有 v2 安装

`pr-flow init` 执行时检测：
1. `mcp-server/pr-flow/server.py` 是否存在
2. 项目中是否有 v2 的 `mcp.json` 引用 `server.py`

如果检测到：输出提示 "检测到 pr-flow v2 安装。v2 Python 版已 EOL，init 将覆盖 mcp.json 配置。v2 审查数据通过向后兼容读取保持可访问。是否继续？"

v2 `server.py` 文件不自动删除，用户可手动清理。

### 向后兼容窗口

v2 marker 兼容读取的向后兼容窗口为 6 个月（至 2027-01-15）。6 个月后移除 v2 marker 读取逻辑，仅保留 Check Run / Commit Status 路径。窗口结束后，SHA 不匹配的 v2 结果仍返回 `expired`（提示重跑 `run_pr_checks`），仅移除旧 SHA 匹配时的 `v2_compat` 读取路径——重跑本身就是迁移。

---

## 十三、分发方式

pr-flow 发布到 npm（`npm publish`），用户通过 `npx pr-flow init` 零安装接入。备选包名 `pr-forge`（`pr-flow` 在 npm registry 可用，如被占用则改用 `pr-forge`）。

### CI/CD

pr-flow 自身的持续集成通过 GitHub Actions 实现。`.github/workflows/publish.yml`：

- `on: push: tags: ['v*']` 触发
- 步骤：`npm ci` → `node --test` → `npm publish`
- 发布前 `node --test` 覆盖第十六节定义的全部单元测试和集成测试

---

## 十四、实现时需验证

- Gitee Commit Status API 协作者写权限
- Gitee 分支保护规则的程序化配置能力
- Gitee 合并权限矩阵
- Gitee Commit Status 在 PR force-push 后的行为（旧状态是否过时）
- monorepo 中自定义 remote 配置下 `git fetch origin` 行为
- 双平台共存场景
- `run_pr_checks` 并发执行时的锁行为验证
- Check Run output 超长截断行为


## 十五、错误码规范

所有 9 个工具统一使用以下错误码：

```js
const ErrorCode = {
  // 认证与权限
  AUTH_REQUIRED:        { code: "AUTH_REQUIRED",         message: "Token 无效或未配置",                     recovery: "运行 pr-flow init 重新配置 token，或检查环境变量 PR_FLOW_TOKEN" },
  // PR 资源
  PR_NOT_FOUND:         { code: "PR_NOT_FOUND",           message: "PR 不存在",                              recovery: "确认 PR 编号正确，确认仓库名和 owner 与当前项目匹配" },
  NO_PULL_REQUEST:      { code: "NO_PULL_REQUEST",        message: "没有 open PR",                           recovery: "当前仓库无可审查的 PR，先创建 PR 或使用 pr_number 参数指定已有 PR" },
  // 文件与配置
  FILE_NOT_FOUND:       { code: "FILE_NOT_FOUND",         message: "文件不存在",                              recovery: "确认文件路径正确，确认 ref 参数指向的分支或 commit 存在" },
  NO_CONFIG:            { code: "NO_CONFIG",              message: ".pr-flow/config.json 不存在",             recovery: "运行 pr-flow init 初始化项目配置" },
  CONFIG_MODIFIED:      { code: "CONFIG_MODIFIED",        message: "config.json 已被修改（hash 不匹配）",       recovery: "确认修改内容后重新运行 pr-flow init 以更新 .approved hash" },
  NO_CHECK_COMMAND:     { code: "NO_CHECK_COMMAND",       message: "check 字段为空",                          recovery: "编辑 .pr-flow/config.json，为每个 phase 填写 check 命令" },
  // 网络
  NETWORK_ERROR:        { code: "NETWORK_ERROR",          message: "API 网络错误",                            recovery: "检查网络连接，确认 GitHub/Gitee 服务可用，稍后重试" },
  RATE_LIMITED:         { code: "RATE_LIMITED",           message: "API 频率限制",                            recovery: "等待 {retry_after} 秒后重试" },
  // Git 操作
  GIT_ERROR:            { code: "GIT_ERROR",              message: "git 命令执行失败",                        recovery: "检查工作区状态（git status），确认网络和远程仓库配置正确" },
  DIRTY_WORKTREE:       { code: "DIRTY_WORKTREE",         message: "工作区有未提交的修改",                     recovery: "先 git stash 暂存或 git commit 提交当前修改，再重新调用" },
  BRANCH_MISMATCH:      { code: "BRANCH_MISMATCH",        message: "branch 与 PR head_ref 不匹配",            recovery: "确认分支名正确，或改用 pr_number 参数代替 branch 参数" },
  NO_CHANGES:           { code: "NO_CHANGES",             message: "没有需要提交的修改",                       recovery: "确认修改已保存（git status 检查），确认文件路径在参数中已指定" },
  GIT_IDENTITY_MISSING: { code: "GIT_IDENTITY_MISSING",   message: "git user.name/email 未配置",              recovery: "运行 git config user.name 和 git config user.email 配置身份信息" },
  // 审查流程
  MERGE_NOT_ALLOWED:    { code: "MERGE_NOT_ALLOWED",      message: "审查未完成，禁止合并",                     recovery: "先调用 run_pr_checks 完成验证，再调用 set_conclusion 完成审查，最后重试合并" },
  MERGE_CONFLICT:       { code: "MERGE_CONFLICT",         message: "合并冲突",                                recovery: "运行 git fetch origin pull/{n}/head && git merge FETCH_HEAD 手动解决冲突后再合并" },
  SHA_MISMATCH:         { code: "SHA_MISMATCH",           message: "body SHA 与参数 SHA 不匹配",               recovery: "确认传入的 SHA 与 PR 当前 head SHA 一致" },
  REVIEW_STALE:         { code: "REVIEW_STALE",           message: "审查结果已过时（PR 可能被 force-push）",     recovery: "重新调用 run_pr_checks 获取最新代码的验证结果，再重新调用 set_conclusion" },
  CODE_UPDATED_DURING:  { code: "CODE_UPDATED_DURING",    message: "执行期间代码被更新",                       recovery: "重新调用 run_pr_checks 以获取最新代码的验证结果" },
  // 并发
  LOCKED:               { code: "LOCKED",                 message: "并发锁被占用，另一个 run_pr_checks 正在执行", recovery: "等待当前执行完成（锁文件会在执行结束后自动释放），1-2 分钟后重试。如果确认没有并发执行，可手动删除 .pr-flow/locks/pr-{n}.lock" },
  // 参数校验
  INVALID_VERDICT:      { code: "INVALID_VERDICT",        message: "verdict 值不合法",                        recovery: "verdict 只能为 success、failure 或 neutral" },
  INVALID_PATH:         { code: "INVALID_PATH",           message: "路径包含非法字符",                         recovery: "使用相对于仓库根目录的合法文件路径，不含 ../ 等目录穿越字符" },
  // 超时
  TIMEOUT:              { code: "TIMEOUT",                message: "执行超时",                                recovery: "增加 .pr-flow/config.json 中的 timeout 值，或优化 check 命令的执行效率" },
  CHECK_FAILED:         { code: "CHECK_FAILED",           message: "验证不通过（非零退出）",                    recovery: "查看 Check Run 输出中的具体错误信息，修复后重新 push 并重试" },
};
```

每个错误码附带 `message` 和 `recovery` 字段，`recovery` 包含 Agent 可执行的操作建议（如"重试"、"暂存后再试"、"重新初始化配置"），确保 Agent 收到错误后能做出 next-step 决策而非退回给用户。所有工具通过 `ErrorCode.LOCKED.code` 等形式引用错误码标识。

---

## 十六、测试策略

| 层级 | 范围 | 工具 |
|------|------|------|
| 单元测试 | 平台 API mock：GitHub/Gitee API 请求/响应对 → `github_api.js`/`gitee_api.js` | Node 内置 `node:test` |
| 单元测试 | 安全校验：`config.json` hash 校验 + `.approved` 比对 | 同上 |
| 单元测试 | 文件锁：排他创建、PID 检测、超时释放、并发争用 | 同上 |
| 集成测试 | `run_pr_checks`：git checkout → 执行 phases → 切回原分支 → 锁释放 | shell 脚本 |
| 集成测试 | `run_pr_checks` 死锁恢复：进程崩溃 → PID 存活检查 → 清理死锁 → 重试获取锁 | shell 脚本 |
| 集成测试 | `run_pr_checks` checkout 失败回退：模拟 checkout 失败 → 验证 `git checkout $ORIG_SHA` 执行 → 锁释放 | shell 脚本 |
| 集成测试 | `commit_and_push`：git add → commit → push 完整链路 | shell 脚本（dry_run 模式） |
| 集成测试 | v2 兼容读取：从 PR comment marker 解析审查结果 | shell 脚本 |
| E2E | 真实 PR 上完整流程：`get_review_plan` → `run_pr_checks` → `set_conclusion` → `merge_pr` | 手动或 CI sandbox |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | autoplan | Scope & strategy | 1 | CLEAR | 3 conditional concerns |
| Eng Review | autoplan | Architecture & tests (required) | 1 | CLEAR | 5 issues (2 P1, 3 P2), 2 critical test gaps |
| DX Review | autoplan | Developer experience gaps | 1 | CLEAR | DX Scorecard 6/10, 8 passes evaluated |

### Architecture

| ID | Severity | Confidence | Description |
|----|----------|------------|-------------|
| A1 | ~~P1~~ RESOLVED | 9/10 | ~~包名 `prflow` 混淆~~ — `pr-flow` 确认 npm registry 可用（404），已作为首选包名写入第十三节，备选 `pr-forge`。原审查误判 `prflow`（无连字符）与 `pr-flow` 冲突，实为不同包名 |
| A2 | ~~P1~~ RESOLVED | 8/10 | ~~缺少 CI/CD pipeline~~ — 第十三节已新增 CI/CD 小节，定义 `.github/workflows/publish.yml`：tag push → npm ci → node:test → npm publish |
| A3 | ~~P2~~ RESOLVED | 8/10 | ~~`config.json` 缺少 `version` 字段~~ — 第五节示例已添加 `"version": "3.0"`，并注明由 init 自动写入、用户不应手动修改 |
| A4 | ~~P2~~ RESOLVED | 6/10 | ~~`execSync(shell: true)` 残余风险~~ — 第三节安全边界段已补充已知攻击场景说明 |
| A5 | ~~P2~~ RESOLVED | 6/10 | ~~monorepo 中的 git 操作行为未定义~~ — 第十四节验证清单已增加 monorepo 自定义 remote 配置项 |
| N2 | ~~NEW~~ RESOLVED | 7/10 | ~~缺少 `RATE_LIMITED` 错误码~~ — 第十五节已增加，含 `retry_after` 占位符 |

### Test Coverage

| ID | Severity | Confidence | Description |
|----|----------|------------|-------------|
| T1 | ~~CRITICAL~~ RESOLVED | 8/10 | ~~无可恢复死锁的集成测试~~ — 第十六节已增加死锁恢复测试行 |
| T2 | ~~CRITICAL~~ RESOLVED | 8/10 | ~~无 git checkout 失败回退的集成测试~~ — 第十六节已增加 checkout 失败回退测试行 |
| T3 | GAP | 7/10 | 无 API rate limit 处理的单元测试（注：RATE_LIMITED 错误码已加，rate limit 处理逻辑的测试仍需补充） |
| T4 | GAP | 6/10 | 无 Check Run output >65535 字符截断验证 |
| T5 | GAP | 6/10 | 无 Gitee Commit Status force-push 过时检测测试 |

### DX Scorecard

| Dimension | Score | Gap |
|-----------|-------|-----|
| Getting Started | 7/10 | 缺少 `pr-flow doctor` 命令 + `--dry-run` 模式 |
| API/CLI/SDK | 7/10 | `commit_and_push` 两个动词合并，无 batch 操作 |
| Error Messages | ~~5/10~~ RESOLVED | 第十五节错误码已全部增加 `message` + `recovery` 字段，新增 `RATE_LIMITED` |
| Documentation | 6/10 | 无 tutorial/API reference，缺 copy-paste 示例 |
| Upgrade Path | 8/10 | v2→v3 迁移完善，v3 自身升级策略缺失 |
| Dev Environment | ~~7/10~~ RESOLVED | CI/CD pipeline 已加入第十三节；TypeScript 类型和 `--dry-run` 仍在 P3 |
| Community | 5/10 | 无许可证/CONTRIBUTING/issue templates |
| DX Measurement | 3/10 | 无任何 DX 测量机制 |
| **Overall DX** | **6/10** | Competitive tier, TTHW 3-5 min |

### Cross-Model Tension

| Topic | Review | Outside Voice | Resolution |
|-------|--------|---------------|------------|
| Node 18 fetch | 稳定可用 | 可能不稳定 | Review 正确 — `fetch` 在 Node 18+ 实验性但功能完整 |
| 文件锁必要性 | 并发控制必要 | NFS 不可靠 | 有效关注 — 文档化并发场景（单机多 Agent），NFS 不适用 |
| v2 双数据源冲突 | 向后兼容读取 | 冲突未解决 | 计划已定义：Check Run 优先，降级到 v2 marker（第 12.5 节步骤 2） |
| Check Run 数据流 | 可读 | 对 AI 不透明 | `get_review_status` 读取 Check Run output.text 完整内容 |

### Implementation Tasks

- [x] **T1 (P1)** — ~~包名注册~~ — `pr-flow` 确认可用，已写入第十三节，备选 `pr-forge`。实现时注册 npm package 即可
- [x] **T2 (P1)** — ~~CI/CD pipeline~~ — 第十三节已新增 CI/CD 小节。实现时创建 `.github/workflows/publish.yml`
- [x] **T3 (P2)** — ~~config.json version 字段~~ — 第五节已添加 `"version": "3.0"` + 说明文字
- [x] **T4 (CRITICAL)** — ~~文件锁 + git checkout 回退集成测试~~ — 第十六节已增加死锁恢复 + checkout 失败回退两行
- [x] **T5 (P2)** — ~~错误消息增强~~ — 第十五节全部 24 个错误码（含 NEW RATE_LIMITED）已改为 `{ code, message, recovery }` 结构
- [ ] **T6 (P2, human: ~1h / CC: ~15min)** — `pr-flow doctor` 命令 — 自动验证 token 权限、config.json、git 环境、npm 注册状态
- [ ] **T7 (P3, human: ~1h / CC: ~15min)** — 文档补齐 — 添加 `docs/getting-started.md`、API reference、MIT 许可证
- [ ] **T6 (P2, human: ~1h / CC: ~15min)** — `pr-flow doctor` 命令 — 自动验证 token 权限、config.json、git 环境、npm 注册状态
- [ ] **T7 (P3, human: ~1h / CC: ~15min)** — 文档补齐 — 添加 `docs/getting-started.md`、API reference、MIT 许可证

**NOT in scope:**
- Web dashboard（列入 12-month ideal）
- 自定义审查策略 DSL（硬编码 AND 逻辑）
- GitLab/Bitbucket 平台支持
- 内置 prompt templates 用于不同 Agent 类型
- TypeScript 类型声明（P3，后续迭代）
- DX 测量 dashboard（P3，后续迭代）

**What already exists:**
- v2 Python 参考实现（概念复用，实现重写）
- v2 PR comment marker 格式（向后兼容读取 6 个月）

**VERDICT:** CEO + ENG + DX CLEARED — ready to implement. T1-T5 (包名/CI/version/测试/错误码) 已在本轮方案中修掉，T6-T7 为实现阶段可选增强。

NO UNRESOLVED DECISIONS
