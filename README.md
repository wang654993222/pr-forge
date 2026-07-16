# pr-forge v3.0

> AI 代码变更安全网关 — Agent 修改代码必须走 PR 审查，验证通过后方可合并

[![npm version](https://img.shields.io/npm/v/pr-forge.svg)](https://www.npmjs.com/package/pr-forge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

<!-- Terminal recording placeholder: ![pr-forge demo](docs/demo.gif) -->

pr-forge 是一套 MCP (Model Context Protocol) 工具集，为 AI Agent 提供 PR 审查安全网关。Agent 通过 9 个 MCP 工具完成从获取 PR 上下文、运行验证、生成审查报告到合并的全流程，所有操作受两层门禁（事实层 + 审查意见层）保护。

---

## ⚠️ 前置配置：GitHub 分支保护规则

**pr-forge 必须配合 GitHub 分支保护规则使用**，否则 Agent 可以绕过 Check Run 直接合并 PR。

### 为什么必须配置？

pr-forge 的两层门禁依赖 Check Run 来阻断不合规的合并：

| 层级 | 机制 | 依赖 |
|:---:|------|------|
| 事实层 | `run_pr_checks` → 各 phase Check Run | 分支保护要求 Check Run **通过** |
| 审查意见层 | `set_conclusion` → conclusion Check Run | 分支保护要求 Check Run **存在** |

**如果不开启分支保护**，Agent 随时可以绕过 `run_pr_checks` / `set_conclusion` 直接调 `merge_pr`，安全网关将形同虚设。

### 配置步骤

在 GitHub 仓库页面操作，或通过 API 一键开启：

**方式 1：GitHub Web UI**

1. 进入仓库 → **Settings** → **Branches** → **Add branch protection rule**
2. **Branch name pattern** 填入 `main`（或你的默认分支）
3. 勾选 **Require status checks to pass before merging**
4. 勾选 **Require branches to be up to date before merging**
5. 不勾选具体 Check Run 名称 — pr-forge 的动态 phase 名称不适合静态列举

**方式 2：GitHub API（推荐）**

```bash
curl -X PUT "https://api.github.com/repos/{owner}/{repo}/branches/main/protection" \
  -H "Authorization: Bearer {token}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -d '{
    "required_status_checks": {
      "strict": true,
      "contexts": []
    },
    "enforce_admins": false,
    "required_pull_request_reviews": null,
    "restrictions": null,
    "allow_force_pushes": false,
    "allow_deletions": false,
    "block_creations": false
  }'
```

> **注意**: `contexts` 保持空数组 `[]`。pr-forge 的 Check Run 名称为动态生成（格式 `pr-forge/{phase_id}`），无法在静态 contexts 列表中预定义。当 `contexts` 为空时，GitHub 要求**最近一次 commit 的所有 Check Run 必须通过** — 这正好满足 pr-forge 的需求。

### 验证保护规则

```bash
# 查看当前分支保护状态
curl -s "https://api.github.com/repos/{owner}/{repo}/branches/main/protection" \
  -H "Authorization: Bearer {token}" \
  -H "Accept: application/vnd.github+json"
```

**配置完成后**，任何 PR 必须先通过 `run_pr_checks`（所有 phase Check Run 绿色）才能被 `merge_pr` 合并。

---

## 安装

```bash
# 一键接入
npx pr-forge init

# 环境诊断
npx pr-forge doctor
```

`init` 自动检测项目类型并生成 `.pr-forge/config.json`，将 token 存入 `~/.pr-forge/credentials`，配置 `.claude/mcp.json`。

## MCP 工具 (9 个)

| # | 工具 | 说明 |
|---|------|------|
| 1 | `get_pr_context` | 获取 PR 元数据（title/state/draft/SHA/branch/author） |
| 2 | `get_review_status` | 读取各 phase Check Run 结论 + 完整审查报告（含聚合状态） |
| 3 | `get_pr_diff` | 获取 PR unified diff |
| 4 | `get_file_content` | 获取仓库文件内容 |
| 5 | `commit_and_push` | 提交修复并推送到 PR 分支 |
| 6 | `merge_pr` | 合并 PR（两层门禁：事实层聚合 + 审查意见） |
| 7 | `run_pr_checks` | 执行 config.json 的 check 命令（多阶段），各 phase 独立写 Check Run |
| 8 | `set_conclusion` | 修改 Check Run 整体结论，附带审查报告 |
| 9 | `get_review_plan` | 动态生成审查步骤清单（无参数自动找最新 open PR） |

## 安全模型

- **config.json 防篡改**：SHA256 hash 对比 `.pr-forge/.approved`
- **Token 存储**：读 `~/.pr-forge/credentials`，文件权限 `0o600`，目录 `0o700`
- **并发控制**：`run_pr_checks` 文件锁 `pr-{n}.lock` + PID 验活 + 死锁恢复

## 平台支持

| 能力 | GitHub | Gitee |
|------|--------|-------|
| 验证结果 | Check Runs API | Commit Status API |
| 审查报告 | Check Run output | PR comment |
| 合并阻断 | 分支保护规则 | 仓库 CI 检查 |

## 要求

- Node.js >= 20

## License

MIT
