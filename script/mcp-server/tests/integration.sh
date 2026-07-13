#!/bin/bash
# tests/integration.sh — MCP → bash → GitHub 端到端验证
# 前置: 真实 PR #42 存在于 GitHub
# 注意: 需要设置 GITHUB_TOKEN env var 才能执行真实场景

echo "=== 集成测试: Relay Review MCP ==="
echo ""

SERVER_PY="$(dirname "$0")/../server.py"
PYTHONPATH="$(dirname "$0")/.."

# 场景 1: 完整 Phase 1 查询流程
echo "Test 1: get_pr_context + get_review_status"
echo "MANUAL: echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"get_pr_context\",\"arguments\":{\"pr_number\":42}}}' | python3 $SERVER_PY 2>/dev/null"
echo ""

# 场景 2: 空 PR (无审查评论)
echo "Test 2: get_review_status on new PR"
echo "MANUAL: echo '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_review_status\",\"arguments\":{\"pr_number\":42}}}' | python3 $SERVER_PY 2>/dev/null"
echo ""

# 场景 3: post_phase_result (dry_run)
echo "Test 3: post_phase_result dry_run"
echo "MANUAL: echo '{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"post_phase_result\",\"arguments\":{\"pr_number\":42,\"phase\":1,\"body\":\"test\",\"sha\":\"abc123\",\"dry_run\":true}}}' | python3 $SERVER_PY 2>/dev/null"
echo ""

# 场景 4: post_final_verdict (invalid)
echo "Test 4: post_final_verdict with invalid verdict"
echo "MANUAL: echo '{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"post_final_verdict\",\"arguments\":{\"pr_number\":42,\"verdict\":\"reject\",\"summary\":\"bad\"}}}' | python3 $SERVER_PY 2>/dev/null"
echo ""

# 场景 5: 网络中断 (mock)
echo "Test 5: simulate network error"
echo "MANUAL: disconnect network and verify get_pr_context returns NETWORK_ERROR"
echo ""

echo "=== Integration tests require real GitHub PR and GITHUB_TOKEN ==="
echo "Run: GITHUB_TOKEN=xxx python3 -m pytest tests/test_handlers.py -v"
