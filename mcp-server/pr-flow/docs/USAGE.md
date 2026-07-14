# pr-flow — 使用指南

> 版本: 2.0.0 (v11) | 最后更新: 2026-07-14

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置 Token

**GitHub:**
```bash
export GITHUB_TOKEN="ghp_xxxx"
# 或
gh auth login
```

**Gitee:**
```bash
export GITEE_TOKEN="your_gitee_token"
# 或强制指定平台
export RELAY_REVIEW_PLATFORM="gitee"
```

### 3. 生成 MCP 配置

```bash
./setup.sh
```

将输出的 JSON 添加到 `.claude/settings.local.json` 或 `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "pr-flow": {
      "command": "python3",
      "args": ["mcp-server/pr-flow/server.py"],
      "cwd": "/path/to/project",
      "env": {
        "GITHUB_TOKEN": "ghp_xxxx",
        "GITHUB_REPOSITORY": "owner/repo"
      }
    }
  }
}
```

> **注意:** 如果使用 Gitee 平台，将 `GITHUB_TOKEN` 改为 `GITEE_TOKEN`，`GITHUB_REPOSITORY` 改为 `GITEE_REPOSITORY`。

### 4. 重启 Claude Code

配置完成后重启 Claude Code，MCP Server 将自动启动。

## 9 个 MCP Tool

### v10 (审查)

| Tool | 功能 |
|------|------|
| `get_pr_context` | 拉取 PR 元数据 (title/state/draft/SHA/branch/author) |
| `get_review_status` | 构建 Phase 1/2/3 审查状态矩阵 + next action |
| `get_phase_result` | 精确提取 Phase N 的审查结果 (SHA 匹配 + 多审查者) |
| `post_phase_result` | 发布审查结果到 PR Comment (65K 截断 + CAS 合并) |
| `post_final_verdict` | 发布最终 PR Review (approve/request_changes/comment) |

### v11 (代码操作)

| Tool | 功能 |
|------|------|
| `get_pr_diff` | 获取 PR unified diff |
| `get_file_content` | 获取仓库文件内容 (支持二进制检测) |
| `commit_and_push` | 提交修复并推送到 PR 分支 (含分支校验 + identity 检查) |
| `merge_pr` | 合并 PR 到主分支 (内置审查完成预检) |

## 完整工作流

```
Phase 1 审查 → Fix 修复 → commit_and_push → Re-Review 再审查
    → Phase 2 接力复核 → Phase 3 DB 验证 → merge_pr 合并
```

## 运行测试

```bash
# 全部测试 (61 个)
PYTHONPATH=mcp-server/pr-flow python3 -m pytest mcp-server/pr-flow/tests/ -v

# 新 Tool 测试 (15 个)
PYTHONPATH=mcp-server/pr-flow python3 -m pytest mcp-server/pr-flow/tests/test_code.py -v

# 现有 handler 测试 (17 个)
PYTHONPATH=mcp-server/pr-flow python3 -m pytest mcp-server/pr-flow/tests/test_handlers.py -v
```
