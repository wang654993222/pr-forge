# pr-flow v3.0 架构方案

> AI 代码变更安全网关 — Agent 修改代码必须走 PR 审查，验证通过后方可合并。任何 Agent 平等协作，不绑角色。

---

## 一、语言迁移：Python → Node.js

**决策：** 从 Python 迁移到 Node.js，零 npm 依赖。

**理由：**

- 目标用户（Claude Code / Codex / Cursor 使用者）已预装 Node.js
- Python 是额外依赖，每多一步就流失一批用户
- `requests` → `fetch`（Node 18+ 内置）、`subprocess` → `child_process`
- 通过 `npx pr-flow` 实现零安装运行

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

**唯一依赖：** Node.js 18+

---

## 三、安全模型

### config.json 防篡改

`run_pr_checks` 执行任意 shell 命令。为防止 Agent 或恶意修改篡改 `config.json`：

1. `init` 生成 `config.json` 时计算 SHA256 hash，存入 `.pr-flow/.approved`
2. `run_pr_checks` 每次执行前对比 `config.json` 的当前 hash 与 `.approved` 中记录
3. hash 一致 → 正常执行
4. hash 不一致 → 拒绝执行，返回 "config.json 已被修改，请确认后重新运行 `pr-flow init`"

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
| 2 | `get_review_status` | `pr_number` | 读 Check Run 结论 + 完整审查报告 |
| 3 | `get_pr_diff` | `pr_number`, `max_bytes?` | 获取 PR unified diff |
| 4 | `get_file_content` | `path`, `ref?` | 获取仓库文件内容 |
| 5 | `commit_and_push` | `message`, `pr_number` 或 `branch`, `files?` | 提交修复并推送（pr_number 和 branch 二选一必传） |
| 6 | `merge_pr` | `pr_number`, `merge_method?`, `force?` | 合并 PR（读 Check Run 状态） |
| 7 | `run_pr_checks` | `pr_number`, `timeout?` | 执行 config.json 的 check 命令，写 Check Run |
| 8 | `set_conclusion` | `pr_number`, `conclusion`, `report_text?` | 修改 Check Run 结论，附带审查报告 |
| 9 | `get_review_plan` | `pr_number?`, `branch?` | 动态生成审查步骤清单（无参数自动找最新 open PR） |

> **v2 能力去留决策：** PR comment API（`list_comments`/`create_comment`/`update_comment`）和 PR Review API（`create_review`）被 Check Run output 取代，不再作为独立工具。如有强需求可后续加回。

---

## 五、`run_pr_checks` — 配置文件驱动的验证

**约定：** 项目根目录 `.pr-flow/config.json`：

```json
{
  "check": "mvn compile -q && mvn test",
  "timeout": 300
}
```

**执行方式：**

`run_pr_checks` 内部使用 Node `execSync(config.check, { shell: true })`。`shell: true` 告诉 Node 使用系统默认 shell——Windows 用 cmd，macOS/Linux 用 sh。

**工具行为：**

1. 安全校验：对比 `.pr-flow/config.json` hash 与 `.pr-flow/.approved`（见第三节）
2. 并发控制：获取文件锁 `.pr-flow/locks/pr-{n}.lock`，已被占用则返回 `LOCKED`
3. `git fetch origin pull/{pr}/head:pr-{pr}`
4. `git checkout pr-{pr}`
5. `execSync(check, { shell: true, timeout })`
6. 记录 exit code / stdout / stderr
7. 切回原分支，释放锁
8. 结果写入 Check Run / Commit Status
9. 返回结构化结果

**异常处理：**

| 情况 | 返回 |
|------|------|
| `config.json` 不存在 | `NO_CONFIG` |
| `config.json` hash 不匹配 | `CONFIG_MODIFIED`，提示重跑 init |
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

**结论状态映射：**

| 审查结论 | GitHub | Gitee |
|----------|--------|-------|
| 全过 | Check Run: `success` | Commit Status: `success` |
| 挂了 | Check Run: `failure` | Commit Status: `failure` |
| 通过但有风险 | Check Run: `neutral` | Commit Status: `success` + merge_pr 走 force 逻辑 |

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
| `run_pr_checks` | 任何 Agent | 跑验证，Check Run 初始为 `success` 或 `failure` |
| `set_conclusion` | 审查 Agent | 修改结论 + 附带审查报告（写入 Check Run output） |
| `merge_pr` | 任何 Agent | 读 Check Run 结论并决策 |

**`merge_pr` 内部逻辑（完整版）：**

```
0. Check Run 不存在 → 拒绝，"未执行 run_pr_checks，禁止合并"
1. 读 Check Run / Commit Status 结论
2. success  → 合并
3. failure  → 拒绝，"先修复"
4. neutral  → 拒绝，"请 force=true 确认"
```

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
2. 合并前 Check Run 必须是 `success`
3. `neutral` 需 `force=true`
4. 谁修好谁调 `set_conclusion` 出报告

---

## 九、审查报告（存入 Check Run output）

审查报告通过 `set_conclusion` 写入 Check Run 的 `output` 字段。

`set_conclusion` 的 `report_text` 参数为完整 Markdown 字符串，Agent 不需构造嵌套 JSON。

**报告 Markdown 约束：**

```markdown
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
get_review_plan()                             → 自动找最近一个 open PR
```

**动态逻辑：**

`get_review_plan` 每次调用时读取 Check Run 当前状态，动态生成步骤清单：

- `run_pr_checks` 已执行 → 步骤标 `[completed]`，跳过
- `set_conclusion` 已调用 → 步骤标 `[completed]`，跳过
- Check Run 不存在 → 步骤包含 `run_pr_checks`
- 无 `config.json` → 验证步骤替换为"人工逐文件检查"
- `merge_pr` 仅在 Check Run 为 `success` 时出现在步骤末尾

**无参数自动查找：**

```
1. 查仓库 open PR 列表，按创建时间倒序
2. 只有 1 个 → 直接返回审查计划
3. 有多个    → 返回 PR 列表让 Agent 选择
4. 没有      → 返回 "当前没有待审查的 PR"
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

**项目检测与默认 check 命令：**

| 检测到 | 识别为 | check 命令 |
|--------|--------|-----------|
| `pom.xml` + `mvnw` | Java (Maven Wrapper) | `./mvnw compile -q && ./mvnw test` |
| `pom.xml` | Java (Maven) | `mvn compile -q && mvn test` |
| `build.gradle` + `gradlew` | Java (Gradle Wrapper) | `./gradlew check` |
| `build.gradle` | Java (Gradle) | `gradle check` |
| `package.json` | Node.js | `npm run lint && npm test` |
| `Cargo.toml` | Rust | `cargo test && cargo clippy` |
| `go.mod` | Go | `go vet ./... && go test ./...` |
| `pyproject.toml` | Python | `pytest -q && ruff check .` |
| 未检测到 | 通用模板 | 提示用户自己填 |

---

## 十二、接入路径对比

| | v2.x（Python） | v3.0（Node） |
|---|---|---|
| 步骤 | 6 步手动 | 3 步（2 步自动） |
| 依赖 | Python 3.9+ + pip install requests | 无 |
| 配置 | 手写 mcp.json | init 自动生成 |
| 验证命令 | 手写 check.sh | 自动检测生成 config.json |
| 审查流程 | Phase 1/2/3 多阶段 | 单次审查 + Check Run |
| Windows | 需 WSL | 原生（execSync shell:true） |
| 审查报告 | PR comment | Check Run output（get_review_status 读取） |
| Token 安全 | mcp.json 明文 | ~/.pr-flow/credentials + hash 校验 |
| 并发安全 | 无 | 文件锁 |

---

## 十三、分发方式

pr-flow 发布到 npm（`npm publish`），用户通过 `npx pr-flow init` 零安装接入。备选包名：`pr-flow` 或 `@pr-flow/cli`。

---

## 十四、实现时需验证

- Gitee Commit Status API 协作者写权限
- Gitee 分支保护规则的程序化配置能力
- Gitee 合并权限矩阵
- Gitee Commit Status 在 PR force-push 后的行为（旧状态是否过时）
- 双平台共存场景
- `run_pr_checks` 并发执行时的锁行为验证
- Check Run output 超长截断行为
