# Relay Review MCP Server — 使用指南

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置 GitHub Token

方式 A: 设置环境变量
```bash
export GITHUB_TOKEN="ghp_xxxx"
```

方式 B: 使用 GitHub CLI
```bash
gh auth login
```

### 3. 生成 MCP 配置

```bash
./setup.sh
```

将输出的 JSON 添加到 `.claude/settings.local.json` 或 `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "relay-review": {
      "command": "python3",
      "args": ["script/mcp-server/server.py"],
      "cwd": "/path/to/project"
    }
  }
}
```

### 4. 重启 Claude Code

配置完成后重启 Claude Code，MCP Server 将自动启动。

## 5 个 MCP Tool

| Tool | 功能 |
|------|------|
| `get_pr_context` | 拉取 PR 元数据 (title/state/draft/SHA/branch) |
| `get_review_status` | 构建 Phase 1/2/3 审查状态矩阵 |
| `get_phase_result` | 精确提取 Phase N 的审查结果 |
| `post_phase_result` | 发布审查结果到 PR Comment |
| `post_final_verdict` | 发布最终 PR Review |

## 运行测试

```bash
# 单元测试
PYTHONPATH=script/mcp-server python3 -m pytest script/mcp-server/tests/test_handlers.py -v

# 全部测试
PYTHONPATH=script/mcp-server python3 -m pytest script/mcp-server/tests/ -v
```

