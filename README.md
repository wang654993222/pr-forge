# pr-forge v3.0

> AI 代码变更安全网关 — Agent 修改代码必须走 PR 审查，验证通过后方可合并

[![npm version](https://img.shields.io/npm/v/pr-forge.svg)](https://www.npmjs.com/package/pr-forge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

pr-forge 是一套 MCP (Model Context Protocol) 工具集，为 AI Agent 提供 PR 审查安全网关。Agent 通过 9 个 MCP 工具完成从获取 PR 上下文、运行验证、生成审查报告到合并的全流程，所有操作受两层门禁（事实层 + 审查意见层）保护。

## 安装

```bash
# 一键接入
npx pr-forge init

# 环境诊断
npx pr-forge doctor
```

`init` 自动检测项目类型并生成 `.pr-forge/config.json`，将 token 存入 `~/.pr-forge/credentials`，配置 `.claude/mcp.json`。

## CLI

```
pr-forge init                项目初始化向导
pr-forge doctor              环境诊断（6 项检查）
pr-forge --version / -v      输出版本号
pr-forge                     启动 MCP server (JSON-RPC over stdin/stdout)
```

## MCP 工具 (9 个)

| # | 工具 | 必填参数 | 说明 |
|---|------|----------|------|
| 1 | `get_pr_context` | `pr_number` | 获取 PR 元数据（title/state/draft/SHA/branch/author） |
| 2 | `get_review_status` | `pr_number` | 读取各 phase Check Run 结论 + 完整审查报告（含聚合状态，校验 SHA 过期） |
| 3 | `get_pr_diff` | `pr_number` | 获取 PR unified diff，支持 `max_bytes` 截断 |
| 4 | `get_file_content` | `path` | 获取仓库文件内容，支持 `ref` 指定分支/commit |
| 5 | `commit_and_push` | `message` | 提交修复并推送到 PR 分支（`pr_number` 或 `branch` 二选一） |
| 6 | `merge_pr` | `pr_number` | 合并 PR（两层门禁：事实层聚合 + 审查意见），neutral 需 `acknowledge=true` |
| 7 | `run_pr_checks` | `pr_number` | 执行 config.json 的 check 命令（多阶段），各 phase 独立写 Check Run |
| 8 | `set_conclusion` | `pr_number`, `conclusion` | 写审查结论（success/failure/neutral），附带 Markdown 审查报告 |
| 9 | `get_review_plan` | 无 | 动态生成审查步骤清单，无参数自动找最新 open PR |

工具返回统一结构 `{ ok: true|false, ... }`。`get_review_plan` 返回 `next_action` + `next_params`，Agent 无需推理下一步。

## 二层结论模型

| 层 | 写工具 | Check Run name | 含义 |
|---|--------|---------------|------|
| 事实层 | `run_pr_checks` | `pr-forge/{phase-id}` | 各 phase 自动化验证结果 |
| 审查意见层 | `set_conclusion` | `pr-forge/conclusion` | 审查 Agent 最终判定 |

`merge_pr` 以"事实层 AND 审查意见层"为合并决策依据。

## 项目结构

```
pr-forge/
├── package.json
├── src/
│   ├── cli.js              # CLI 入口（init / doctor / MCP server）
│   ├── cli-init.js         # init 命令
│   ├── cli-doctor.js       # doctor 命令
│   ├── server.js           # MCP JSON-RPC over stdin/stdout
│   ├── config.js           # 配置加载 + SHA256 hash 校验
│   ├── context.js          # git remote 检测 + 平台解析
│   ├── init.js             # 项目初始化逻辑
│   ├── doctor.js           # 环境诊断逻辑
│   ├── lock.js             # 文件锁（排他创建 + PID 验活 + 死锁恢复）
│   ├── error-codes.js      # 24 个统一错误码（message + recovery）
│   ├── tools/
│   │   ├── context.js      # get_pr_context
│   │   ├── review.js       # get_review_plan + get_review_status (含 v2 兼容)
│   │   ├── code.js         # get_pr_diff + get_file_content
│   │   ├── git.js          # commit_and_push
│   │   ├── checks.js       # run_pr_checks
│   │   └── conclusion.js   # set_conclusion + merge_pr
│   └── platforms/
│       ├── router.js       # 平台检测 + 工厂
│       ├── github.js       # GitHub API + Check Runs
│       └── gitee.js        # Gitee API + Commit Status
```

## 安全模型

- **config.json 防篡改**：SHA256 hash 对比 `.pr-forge/.approved`，每次 `run_pr_checks` 前校验
- **Token 存储**：读 `~/.pr-forge/credentials`，文件权限 `0o600`，目录 `0o700`。同时写入 `.claude/mcp.json`（自动加入 `.gitignore`）
- **并发控制**：`run_pr_checks` 文件锁 `pr-{n}.lock` + PID 验活 + 死锁恢复
- **路径安全**：`get_file_content` 拒绝 `..` 路径穿越；`commit_and_push` 校验文件路径

## 平台支持

| 能力 | GitHub | Gitee |
|------|--------|-------|
| 验证结果 | Check Runs API | Commit Status API |
| 审查报告 | Check Run output | PR comment |
| 合并阻断 | 分支保护规则 | 仓库 CI 检查 |
| 结论类型 | success / failure / neutral | success / failure |

## 项目检测（pr-forge init）

自动检测 8 种项目类型：Java (Maven/Gradle Wrapper/Gradle)、Node.js、Rust、Go、Python。

## v2 兼容

v2 Python 版审查数据通过 PR comment marker（`<!-- review-phase: N -->` + `<!-- review-commit: SHA -->`）向后兼容读取。`get_review_status` / `merge_pr` 在 Check Run 不存在时降级搜索 v2 marker。

## 要求

- Node.js >= 20

## License

MIT
