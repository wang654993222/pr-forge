#!/bin/bash
echo "=== pr-flow MCP Setup ==="
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
echo "Project root: $PROJECT_ROOT"

# 1. Python 依赖
echo "Installing Python deps..."
pip install -r "$(dirname "$0")/requirements.txt" 2>/dev/null || echo "⚠ pip install failed — please manually install requests"

# 2. MCP 配置生成
MCP_JSON=$(cat <<EOF
{
  "mcpServers": {
    "pr-flow": {
      "command": "python3",
      "args": ["mcp-server/pr-flow/server.py"],
      "cwd": "$PROJECT_ROOT"
    }
  }
}
EOF
)
echo ""
echo "=== Add to .claude/settings.local.json or .claude/mcp.json ==="
echo "$MCP_JSON"

# 3. Skill 文件复制
SKILL_SRC="$PROJECT_ROOT/mcp-server/pr-flow/docs/pr-flow.md"
SKILL_DST="$HOME/.claude/skills/pr-flow.md"
if [ -f "$SKILL_SRC" ]; then
    cp "$SKILL_SRC" "$SKILL_DST" 2>/dev/null && echo "✅ Skill copied to $SKILL_DST" || echo "⚠ Please manually copy $SKILL_SRC → $SKILL_DST"
fi

# 4. Windows 检测
case "$(uname -s)" in
    MINGW*|MSYS*) echo "⚠ Windows Git Bash detected. Python may not be available. Consider WSL2." ;;
esac

echo ""
echo "=== Setup complete ==="
echo "Next: restart Claude Code, then say: 审查 PR #N"
