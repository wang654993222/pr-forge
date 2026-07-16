# Relay Review MCP — 实现计划 (v10 — Gitee 平台支持 + 并发审查合并 + 多结果保留)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 Relay Review MCP Server — 5 个核心 MCP tool + requests 依赖，通过 JSON-RPC over stdin/stdout 暴露 GitHub/Gitee PR 审查状态查询与写入。v10 新增 Gitee 平台支持 (方案A: 独立 API 封装)。

**Architecture:** MCP Server 通过 `requests` 直连 GitHub/Gitee REST API。bash 层（`script/review-pr.sh` 等）作为**前置依赖**已存在。Skill 层编排三者：调 MCP tool 查状态 → 调 bash 执行审查 → 调 MCP tool 发布结果。

**前置依赖:** bash 审查脚本必须已存在（`script/review-pr.sh`, `review-utils.sh`, `prompts/`）。来自 relay-review bash 计划（20 轮审查）。

**Tech Stack:** Python 3.9+, requests, typing.Optional；bash 4.0+；MCP JSON-RPC 2.0

**v10 修订 (Gitee 平台支持):**

- G1: 新增 `gitee_api.py` — Gitee REST API v5 封装 (~60 行)，与 github_api.py 接口一致 ✅ 已修
- G2: `config.py` 新增 `detect_platform()` — 双平台自动检测 (RELAY_REVIEW_PLATFORM → GITEE_TOKEN → git remote → 默认 github) ✅ 已修
- G3: `config.py` `detect_repo_info` 支持 gitee.com URL 解析 (HTTPS + SSH) ✅ 已修
- G4: `tools/_shared.py` 新增平台路由 — 根据 platform 选择 GitHubAPI 或 GiteeAPI ✅ 已修
- G5: Gitee `create_review` 降级为 `create_comment` (Gitee 无 PR Review API) ✅ 已修
- G6: Gitee `merge_pr` 一步自动合并 (Gitee 独有: PUT /pulls/{n}/merge) ✅ 已修
- G7: 测试 30 → 46 个，新增 Gitee API + config 双平台测试 ✅ 已修

**v9 修订 (并发审查合并):**

- C1: `post.py` 新增 `_find_existing_phase_comment` — 检测已有同 Phase+SHA 的 Comment，实现 CAS 追加而非 skip ✅ 已修
- C2: `post.py` 新增 `_extract_findings_only` + `_merge_phase_comment` — 提取纯 findings 并追加到已有 Comment，支持多人并发审查结果合并 ✅ 已修
- C3: `status.py` `_build_phase_status` 支持多审查者 — 新增 `contributors[]`、`reviewer_count`、`merged` 字段 ✅ 已修
- C4: `status.py` `tool_get_phase_result` 支持多结果返回 — 新增 `count`、`all_results[]`、`contributors[]` 字段 ✅ 已修
- C5: 测试 21 → 30 个，新增 9 个并发审查测试 ✅ 已修

**v8 修订 (部署验证 + 多机协作发现):**

- D1: `settings.local.json` 与 `.claude/mcp.json` 的 MCP 配置重复 — 删除 `settings.local.json` 中的 `mcpServers`，`.claude/mcp.json` 作为唯一配置源 ✅ 已修
- D2: `config.py` 错误消息提示 `GITHUB_REPOSITORY=owner/repo` 但代码未实现该环境变量回退 — 补充 `detect_repo_info` 空值后从 `GITHUB_REPOSITORY` 解析的 fallback ✅ 已修
- D3: `post_final_verdict` 使用 `approve` 时 GitHub API 返回 422 "Can not approve your own pull request" — 这是 GitHub 自身限制而非代码 bug，文档已说明；跨机器审查时 approve 正常工作 ✅ 已记录
- D4: 多机安装指南补充 — `.claude/mcp.json` + `~/.claude/settings.json` `enableAllProjectMcpServers` + `enabledMcpjsonServers` 三项配置缺一不可 ✅ 已记录

**v7 修订 (计划代码 bug 修复 — 实施中发现的 5 个问题):**

- B1: `_shared.py` `get_api()` 使用 `GitHubAPI(**config["github"])` — config["github"] 的 key 是 `repo_owner`/`repo_name` 但 GitHubAPI.\_\_init\_\_ 的形参是 `owner`/`repo`，参数名不匹配导致 TypeError ✅ 已修
- B2: `status.py` `tool_get_phase_result` 调用 `_get_api(config)` — v4 已将 `_get_api` 抽取到 `_shared.py` 并重命名为 `get_api`，此处死代码引用未更新 ✅ 已修
- B3: `post.py` `_ensure_markers` 辅助函数缺失 — plan 中的代码块有一个无意义的 stub 占位，实际的 `_ensure_markers` 函数被意外删除 ✅ 已修
- B4: `post.py` 有两个 `def tool_post_phase_result` 定义 — 第一个是碎片 stub（使用了未定义的变量 `phase`/`body`/`sha`），第二个才是真正实现 ✅ 已修 (删除重复 stub)
- B5: `config.py` 错误消息提示 `GITHUB_REPOSITORY=owner/repo` 但代码未实现该环境变量回退 — 补充回退逻辑 ✅ 已修

**v6 修订 (阻塞 bug + 死代码清理):**

v5 changelog 声称了部分未在代码中体现的修复。v6 诚实标注。

- L3: context.py 补 `import os, subprocess`（代码无法运行）✅ 已修
- L3: 删 `_get_api` 局部定义（重复 shadowing `get_api` from `_shared`）✅ 已修
- L3: 删 Task 0.2 `parse_utils.py`（死代码）✅ 已修
- L4: `post_final_verdict` 加 verdict 前置校验（`INVALID_VERDICT` 错误码）✅ 已修

**实现时补（在 Task 中标注，非计划阶段声称已修）:**
- `get_review_status`: 补 `blocking[]`, `suggested_action`, `can_watch` — Task 1.2
- `get_phase_result`: 补 `truncated` — Task 1.2
- `post_phase_result`: 补 `embedded_sha`, `embedded_phase`, `markers_auto_inserted`, `truncated_bytes` — Task 1.3

**Spec:** `docs/superpowers/specs/2026-07-11-relay-review-mcp-design.md`

**修订依据:** CEO+Eng+DX 三 Phase 双角色 + 独立审查 (10 轮累计)，全量采纳。

**v4 修订 vs v3:**
- 架构: MCP 用 `requests` 直连 GitHub（删除 bash subprocess 间接层 + parse_utils.py）
- bash 脚本列为前置依赖（来自 relay-review bash 计划，无需重建）
- `_compute_overall` ready/reason 语义修复（Phase 1 done + Phase 2 pending → ready=true）
- Skill: 删除 PR label advisory lock（接受事后 `DUPLICATE_PHASE` 检测）
- 类型: 统一用 `Optional[str]`（兼容 3.9）
- `get_api` 抽取到 `tools/_shared.py`
- `get_review_status` 增加 `phase3_needed` 推导字段
- 集成测试: 5 个具体场景
- 依赖: `requests` only（删 `pyyaml` — config.py 无 YAML 逻辑）
- Python: 3.8+ → 3.9+（`str | None` 语法需 3.10+，用 `Optional[str]` 兼容 3.9）
- 修复 `list_comments` 分页致命 bug（先 extend 后判断）
- 删除 `get_pr_diff_status` 声明（5 tool 核心不需要）
- 补充完整 Skill 文件内容（Phase 1/2/3 操作指令 + 错误恢复 + 轮询策略）
- Skill 轮询逻辑: 30s interval, 60 次上限 (30min), 指数退避
- PR label advisory lock: `review:phase-{N}-in-progress` / `review:lock-failed`
- `post_phase_result` inputSchema 补全 `from_local_file`

---

## 文件结构总览

```
script/mcp-server/                      # 全部新建
├── server.py                           # JSON-RPC over stdin/stdout 入口
├── config.py                           # 自动检测 GitHub/Gitee token/repo + env var 配置 (v10)
├── github_api.py                       # GitHub REST API 封装 (requests, ~30 loc)
├── gitee_api.py                        # Gitee REST API v5 封装 (v10 新增)
├── tools/
│   ├── __init__.py
│   ├── _shared.py                      # get_api factory + 平台路由 (v10)
│   ├── context.py                      # Tool 1: get_pr_context
│   ├── status.py                       # Tool 2-3: get_review_status, get_phase_result
│   └── post.py                         # Tool 4-5: post_phase_result, post_final_verdict
├── tests/
│   ├── test_github_api.py              # github_api.py 单元测试 (mock requests)
│   ├── test_gitee_api.py               # gitee_api.py 单元测试 (v10 新增)
│   ├── test_config.py                  # config.py 双平台检测测试 (v10)
│   └── test_handlers.py                # 5 tool handler 单元测试 (mock API)
├── setup.sh                            # 自动检测 + 生成 MCP 配置 + 复制 Skill
├── requirements.txt                    # requests>=2.31
├── requirements-test.txt               # pytest>=8.0
└── USAGE.md                            # 使用指南 (放在 Phase 6 后)
```

---

## 5 个核心 MCP Tool

| # | Tool | 组 | 功能 |
|---|------|:---:|------|
| 1 | `get_pr_context` | 上下文 | 拉取 PR 元数据 (title/state/draft/SHA/branch) |
| 2 | `get_review_status` | 状态 | 构建 Phase 1/2/3 审查状态矩阵 + next action |
| 3 | `get_phase_result` | 状态 | 精确提取 Phase N 的审查结果 (SHA 匹配) |
| 4 | `post_phase_result` | 写入 | 发布审查结果到 PR Comment (65K 截断 + Gist fallback) |
| 5 | `post_final_verdict` | 写入 | 发布最终 PR Review (Approve/Request Changes) |

**已移除**（v2 延后或砍掉，共 22 个。注：Tools 2 `get_pr_diff_status` + 3 `fetch_pr_diff` 属于 bash 层，不由 MCP 实现）：
- 延后到 v2: `needs_db_verify`, `recommend_verdict`, `wait_for_phase`, `get_cached_diff`, `get_template`, `search_references`, `get_diff_statistics`, `get_machine_status`, `get_review_readiness`, `detect_phase_conflicts`, `resolve_phase_conflict`, `invalidate_cache`, `generate_final_summary`, `compare_phase_results`
- 已砍掉: `update_phase_comment`（合并）, `retry_post_phase`（合并为 `from_local_file` 参数）, `check_db_availability`, `validate_environment`, `estimate_tokens`, `check_pr_reviewable`（单行 bash 厚封装）
- **bash 层工具**（不属于 MCP）: `get_pr_diff_status`(Tool 2), `fetch_pr_diff`(Tool 3) — 由 `script/review-pr.sh` 内部的 `get_pr_diff()` 实现
- Tool count: Spec 27 个唯一 = 5 核心(MCP) + 2 bash层 + 14 延后(v2) + 6 砍掉 ✅

---

## Phase 0: MCP 骨架

### Task 0.1: 项目结构初始化 + requirements

**Files:**
- Create: `script/mcp-server/__init__.py`, `tools/__init__.py`, `tests/__init__.py`
- Create: `script/mcp-server/requirements.txt`, `requirements-test.txt`

```bash
mkdir -p script/mcp-server/tools script/mcp-server/tests
touch script/mcp-server/__init__.py script/mcp-server/tools/__init__.py script/mcp-server/tests/__init__.py
```

`requirements.txt`:
```
requests>=2.31.0
```

`requirements-test.txt`:
```
pytest>=8.0.0
```

```bash
pip install -r script/mcp-server/requirements.txt
```

---

### Task 0.2: parse_utils.py — bash stdout 提取 + $ 转义

**Create:** `script/mcp-server/parse_utils.py`, `tests/test_parse_utils.py`

```python
# parse_utils.py
import json, re, os

def extract_json_section(stdout: str) -> dict | None:
    match = re.search(r'---JSON_START---\s*\n(.*?)\n\s*---JSON_END---', stdout, re.DOTALL)
    if not match: return None
    try: return json.loads(match.group(1))
    except json.JSONDecodeError: return None

def escape_dollar_for_prompt(text: str) -> str:
    try: token = os.urandom(4).hex()
    except NotImplementedError:
        import random; token = f"{random.getrandbits(32):08x}"
    return text.replace("$", f"__DLR__{token}__")

def extract_error_from_stderr(stderr: str) -> str:
    """从 stderr 提取有用错误信息"""
    lines = [l.strip() for l in stderr.split("\n") if l.strip()]
    return "; ".join(lines[-3:]) if lines else "unknown error"
```

---

### Task 0.3: config.py — 自动检测 (env var + gh CLI, 无 YAML)

**Create:** `script/mcp-server/config.py`, `tests/test_config.py`

**Test (mock, 不在真实 git 仓库跑):**

```python
# tests/test_config.py
from unittest.mock import patch
from config import detect_github_token, detect_repo_info, load_config

@patch('subprocess.run')
def test_detect_repo_info_https(mock_run):
    mock_run.return_value.stdout = "https://github.com/wang/hsoft.git\n"
    mock_run.return_value.returncode = 0
    owner, repo = detect_repo_info()
    assert owner == "wang"; assert repo == "hsoft"

@patch('subprocess.run')
def test_detect_repo_info_ssh(mock_run):
    mock_run.return_value.stdout = "git@github.com:alice/hsoft-data-manage.git\n"
    mock_run.return_value.returncode = 0
    owner, repo = detect_repo_info()
    assert owner == "alice"; assert repo == "hsoft-data-manage"
```

**Implementation:**

```python
```python
# config.py — 自动检测 (env var + gh CLI, 无 YAML)
from typing import Optional
import os, subprocess

def detect_github_token() -> Optional[str]:
    token = os.environ.get("GITHUB_TOKEN")
    if token: return token
    try:
        result = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True,
            timeout=5, stdin=subprocess.DEVNULL
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None

def detect_repo_info() -> tuple:
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            url = result.stdout.strip()
            for prefix in ["https://github.com/", "git@github.com:"]:
                if prefix in url:
                    path = url.split(prefix)[-1].replace(".git", "")
                    parts = path.split("/")
                    if len(parts) >= 2: return parts[-2], parts[-1]
    except Exception: pass
    return None, None

def load_config() -> dict:
    token = detect_github_token()
    if not token:
        raise RuntimeError(
            "GitHub token not found. Set GITHUB_TOKEN env var or run 'gh auth login'."
        )
    owner, repo = detect_repo_info()
    if (not owner or not repo) and "GITHUB_REPOSITORY" in os.environ:
        parts = os.environ["GITHUB_REPOSITORY"].split("/")
        if len(parts) >= 2: owner, repo = parts[-2], parts[-1]
    if not owner or not repo:
        raise RuntimeError(
            "Could not detect GitHub repo from git remote. Set GITHUB_REPOSITORY=owner/repo."
        )
    return {
        "github": {"token": token, "repo_owner": owner, "repo_name": repo},
        "output": {"dir": os.environ.get("REVIEW_OUTPUT_DIR", "script/review-output")},
        "mcp": {"log_level": os.environ.get("REVIEW_LOG_LEVEL", "info")},
    }
```

**关键修复 vs v1:**
- 删除 YAML 支持 (`import yaml`, `_deep_merge`, `Path`)
- `gh auth token` 调用加 `stdin=subprocess.DEVNULL` 防交互式 hang (#1E)
- token/owner/repo 检测失败时 `raise RuntimeError`（不在运行中静默返回 None）
- `detect_repo_info` 支持 SSH 格式（`git@github.com:owner/repo.git`）

---

### Task 0.4: github_api.py — requests 实现 (~30 loc)

**Create:** `script/mcp-server/github_api.py`, `tests/test_github_api.py`

```python
# github_api.py
import requests, json

class GitHubAPIError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code; self.message = message
        super().__init__(f"GitHub API Error ({status_code}): {message}")

class GitHubAPI:
    def __init__(self, token, owner, repo):
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "relay-review-mcp/1.0",
        })
        self.base = f"https://api.github.com/repos/{owner}/{repo}"

    def _request(self, method, path, **kwargs):
        url = f"{self.base}/{path}"
        resp = self.session.request(method, url, timeout=30, **kwargs)
        if not resp.ok:
            raise GitHubAPIError(resp.status_code, resp.json().get("message", resp.text))
        return resp.json() if resp.text else {}

    def get_pr(self, pr_number):      return self._request("GET", f"pulls/{pr_number}")
    def list_comments(self, pr_number, per_page=100):
        all_data, page = [], 1
        while True:
            data = self._request("GET", f"issues/{pr_number}/comments?per_page={per_page}&page={page}")
            if not isinstance(data, list): break
            all_data.extend(data)
            if len(data) < per_page: break
            page += 1
        return all_data
    def create_comment(self, pr_number, body):
        return self._request("POST", f"issues/{pr_number}/comments", json={"body": body})
    def update_comment(self, comment_id, body):
        return self._request("PATCH", f"issues/comments/{comment_id}", json={"body": body})
    def create_review(self, pr_number, body, event="COMMENT"):
        return self._request("POST", f"pulls/{pr_number}/reviews", json={"body": body, "event": event})
```

**关键修复 vs v1:**
- 用 `requests.Session` 替代 `urllib`（连接池、自动重试、SSL）(#B 挑战)
- `list_comments` 正确分页——check `isinstance(data, list)` (#7 Eng fatal bug)
- 删除 `update_comment` 死代码 `full_path` 变量
- 30 行 vs v1 的 80 行

---

### Task 0.5: server.py — MCP JSON-RPC 入口

**Create:** `script/mcp-server/server.py`

```python
#!/usr/bin/env python3
"""Relay Review MCP Server — JSON-RPC over stdin/stdout"""
import json, sys, os, traceback
sys.path.insert(0, os.path.dirname(__file__))
from config import load_config
from tools.context import register_context_tools
from tools.status import register_status_tools
from tools.post import register_post_tools

VERSION = "1.0.0"

def main():
    config = load_config()
    tools = _build_tool_registry()
    _log(f"Relay Review MCP v{VERSION} starting", "INFO")

    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: request = json.loads(line)
        except json.JSONDecodeError as e:
            _send_error(None, -32700, f"Parse error: {e}"); continue
        method = request.get("method", ""); rid = request.get("id")
        if method == "initialize":
            _send_response(rid, {"protocolVersion": "2024-11-05",
                "serverInfo": {"name": "relay-review-mcp", "version": VERSION},
                "capabilities": {"tools": {}}})
        elif method == "notifications/initialized": pass
        elif method == "tools/list":
            _send_response(rid, {"tools": [v["schema"] for v in tools.values()]})
        elif method == "tools/call":
            name = request.get("params", {}).get("name", "")
            args = request.get("params", {}).get("arguments", {})
            _handle_tool_call(rid, name, args, tools, config)
        else: _send_error(rid, -32601, f"Method not found: {method}")
    _log("Relay Review MCP exiting", "INFO")

def _build_tool_registry():
    r = {}
    register_context_tools(r)
    register_status_tools(r)
    register_post_tools(r)
    return r

def _handle_tool_call(rid, name, args, registry, config):
    if name not in registry:
        _send_error(rid, -32602, f"Unknown tool: {name}"); return
    try:
        handler = registry[name]["handler"]
        result = handler(args, config)
        text = json.dumps(result, ensure_ascii=False, indent=2)
        _send_response(rid, {"content": [{"type": "text", "text": text}]})
    except Exception as e:
        tb = traceback.format_exc()
        # Token mask: 避免 token 泄露到日志
        if "token" in config.get("github", {}):
            tb = tb.replace(config["github"]["token"], "***")
        _log(f"Tool '{name}' failed: {tb}", "ERROR")
        _send_response(rid, {"content": [{"type": "text", "text": json.dumps(
            {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": str(e)}},
            ensure_ascii=False)}], "isError": True})

def _send_response(rid, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def _send_error(rid, code, message):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def _log(msg, level="INFO"):
    sys.stderr.write(f"[{level}] relay-review-mcp: {msg}\n"); sys.stderr.flush()

if __name__ == "__main__": main()
```

---

## Phase 1: 核心 Tool (5 个)

### Task 1.1: context.py — get_pr_context

**Create shared module first:** `script/mcp-server/tools/_shared.py`

```python
# tools/_shared.py
from github_api import GitHubAPI

def get_api(config: dict) -> GitHubAPI:
    """返回已认证的 GitHubAPI 实例。
    
    v7 修复: 使用显式参数名，因为 config["github"] 的 key (repo_owner, repo_name)
    与 GitHubAPI.__init__ 的形参 (owner, repo) 不匹配。
    """
    return GitHubAPI(config["github"]["token"], config["github"]["repo_owner"], config["github"]["repo_name"])
```

**Create:** `script/mcp-server/tools/context.py`

```python
# tools/context.py
import os
from github_api import GitHubAPI, GitHubAPIError
from tools._shared import get_api

PROJECT_ROOT = os.environ.get("PROJECT_ROOT", os.getcwd())

def register_context_tools(registry):
    registry["get_pr_context"] = {
        "schema": {"name": "get_pr_context", "description": "拉取 PR 元数据",
            "inputSchema": {"type": "object", "properties": {"pr_number": {"type": "integer"}}, "required": ["pr_number"]}},
        "handler": tool_get_pr_context,
    }

def tool_get_pr_context(args, config):
    pr = args["pr_number"]
    api = get_api(config)
    try:
        data = api.get_pr(pr)
        return {"ok": True, "data": {
            "number": data.get("number"), "title": data.get("title"),
            "body": data.get("body"), "state": data.get("state", "OPEN"),
            "draft": data.get("draft", False),
            "labels": [l["name"] for l in data.get("labels", [])],
            "base_branch": data.get("base", {}).get("ref"),
            "head_sha": data.get("head", {}).get("sha"),
            "head_ref": data.get("head", {}).get("ref"),
            "author": data.get("user", {}).get("login"),
            "url": data.get("html_url"),
            "created_at": data.get("created_at"),
            "updated_at": data.get("updated_at"),
        }}
    except GitHubAPIError as e:
        code = "AUTH_REQUIRED" if e.status_code in (401, 403) else \
               "PR_NOT_FOUND" if e.status_code == 404 else "NETWORK_ERROR"
        return {"ok": False, "error": {"code": code, "message": e.message}}
```

---

### Task 1.2: status.py — get_review_status + get_phase_result

```python
# tools/status.py
import re, os
from datetime import datetime, timezone
from github_api import GitHubAPI, GitHubAPIError
from tools._shared import get_api

def register_status_tools(registry):
    registry["get_review_status"] = {
        "schema": {"name": "get_review_status", "description": "构建 Phase 1/2/3 审查状态矩阵",
            "inputSchema": {"type": "object", "properties": {"pr_number": {"type": "integer"}}, "required": ["pr_number"]}},
        "handler": tool_get_review_status,
    }
    registry["get_phase_result"] = {
        "schema": {"name": "get_phase_result", "description": "精确提取 Phase N 审查结果",
            "inputSchema": {"type": "object",
                "properties": {"pr_number": {"type": "integer"}, "phase": {"type": "integer", "enum": [1, 2, 3]}},
                "required": ["pr_number", "phase"]}},
        "handler": tool_get_phase_result,
    }

def tool_get_review_status(args, config):
    pr = args["pr_number"]; api = get_api(config)
    try: pr_data = api.get_pr(pr); comments = api.list_comments(pr)
    except GitHubAPIError as e:
        code = "AUTH_REQUIRED" if e.status_code in (401, 403) else \
               "PR_NOT_FOUND" if e.status_code == 404 else "NETWORK_ERROR"
        return {"ok": False, "error": {"code": code, "message": e.message}}
    current_sha = pr_data.get("head", {}).get("sha")
    phases = _build_phase_status(comments, current_sha)
    return {"ok": True, "data": _compute_overall(phases)}

def _build_phase_status(comments, current_sha):
    """v9: 支持多审查者并发 — contributors[], reviewer_count, merged"""
    phases = {1: [], 2: [], 3: []}
    for c in comments:
        body = c.get("body", "")
        pm = re.search(r"<!-- review-phase: (\d) -->", body)
        sm = re.search(r"<!-- review-commit: ([a-f0-9]+) -->", body)
        if pm:
            p = int(pm.group(1)); sha = sm.group(1) if sm else None
            phases[p].append({
                "sha": sha, "author": c.get("user", {}).get("login"),
                "posted_at": c.get("created_at"), "url": c.get("html_url"), "body": body,
                "comment_id": c.get("id")
            })
    result = []
    for p in [1, 2, 3]:
        entries = phases[p]
        if entries:
            latest = entries[-1]
            expired = latest["sha"] and current_sha and latest["sha"] != current_sha
            result.append({
                "phase": p,
                "status": "expired" if expired else "done",
                "sha": latest["sha"],
                "author": latest["author"],
                "posted_at": latest["posted_at"],
                "url": latest["url"],
                "reason": "SHA mismatch" if expired else None,
                "reviewer_count": len(entries),                         # v9: 新增
                "contributors": [e["author"] for e in entries],         # v9: 新增
                "merged": any("<!-- merged: true -->" in e.get("body", "") for e in entries),  # v9: 新增
            })
        else:
            result.append({"phase": p, "status": "pending", "reviewer_count": 0})  # v9: 新增字段
    return result

def _compute_overall(phases):
    any_started = any(p["status"] != "pending" for p in phases)
    has_expired = any(p["status"] == "expired" for p in phases)
    all_done = all(p["status"] == "done" for p in phases)
    if not any_started: overall, next_p, ready, reason = "not_started", 1, True, "not_started"
    elif has_expired:
        ep = next(p for p in phases if p["status"] == "expired")
        overall, next_p, ready, reason = "blocked", ep["phase"], False, "phase_expired"
    elif all_done: overall, next_p, ready, reason = "complete", 0, False, "complete"
    else:
        pending = [p for p in phases if p["status"] == "pending"]
        # ready=True 表示前置阶段已完成，当前阶段可以开始
        overall, next_p, ready, reason = "in_progress", pending[0]["phase"], True, "phase_pending"
    return {"phases": phases, "overall": overall,
        "phase3_needed": _derive_phase3_needed(phases),
        "next": {"phase": next_p, "ready": ready, "reason": reason}

def _derive_phase3_needed(phases):
    """从 Phase 1/2 结果推导是否需要 Phase 3"""
    for p in [1, 2]:
        phase = next((x for x in phases if x["phase"] == p), None)
        if phase and phase["status"] == "done" and phase.get("body"):
            # 检查 body 中是否提及 SQL 关键词
            body = phase.get("body", "")
            import re
            if re.search(r"(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|N\+1|全表扫描|索引|EXPLAIN)", body, re.I):
                return {"checked": True, "needed": True, "confidence": "high"}
    return {"checked": True, "needed": False, "confidence": "high"}

def tool_get_phase_result(args, config):
    """v9: 支持多审查者并发 — 返回 count, all_results[], contributors[]"""
    pr = args["pr_number"]; phase = args["phase"]; api = get_api(config)
    try: pr_data = api.get_pr(pr); comments = api.list_comments(pr)
    except GitHubAPIError as e:
        code = "AUTH_REQUIRED" if e.status_code in (401, 403) else \
               "PR_NOT_FOUND" if e.status_code == 404 else "NETWORK_ERROR"
        return {"ok": False, "error": {"code": code, "message": e.message}}
    current_sha = pr_data.get("head", {}).get("sha")

    # 收集所有匹配当前 SHA + phase 的 Comment（v9: 支持多人并发审查）
    matching = []
    for c in reversed(comments):
        body = c.get("body", "")
        if f"<!-- review-phase: {phase} -->" in body and f"<!-- review-commit: {current_sha} -->" in body and "---REVIEW_START---" in body:
            matching.append({
                "body": body,
                "sha": current_sha,
                "posted_at": c.get("created_at"),
                "author": c.get("user", {}).get("login"),
                "url": c.get("html_url"),
                "comment_id": c.get("id"),
            })

    if matching:
        primary = matching[0]  # reversed 顺序，最新在前
        return {"ok": True, "data": {
            "found": True, "reason": "ok",
            "count": len(matching),                                     # v9: 新增
            "merged": "<!-- merged: true -->" in primary["body"],       # v9: 新增
            "body": primary["body"],                                    # 合并后或最新的完整 body
            "sha": current_sha,
            "posted_at": primary["posted_at"],
            "author": primary["author"],
            "url": primary["url"],
            "contributors": [m["author"] for m in matching],            # v9: 新增
            "all_results": matching,                                    # v9: 新增
        }}

    # 没有完全匹配的，查找 SHA 不匹配的旧结果
    for c in reversed(comments):
        body = c.get("body", "")
        if f"<!-- review-phase: {phase} -->" in body and "---REVIEW_START---" in body:
            sm = re.search(r"<!-- review-commit: ([a-f0-9]+) -->", body)
            return {"ok": True, "data": {"found": False, "reason": "sha_mismatch",
                "mismatch": {"requested_sha": current_sha, "existing_sha": sm.group(1) if sm else "unknown",
                "existing_posted_at": c.get("created_at"), "old_result_still_exists": True}}}
    return {"ok": True, "data": {"found": False, "reason": "no_result"}}
```

## 并发审查合并机制 (v9 新增)

### 设计原则

拥抱并发，不在代码层面阻止多人同时审查同一 Phase。通过 CAS 追加 + 多结果保留实现零丢失。

### CAS 追加流程

```
先到者: create_comment → 正常发布
后到者: _find_existing_phase_comment → 找到已有 Comment
       → _merge_phase_comment → 追加到已有 Comment 后面
       → update_comment → 合并完成 ✅
       → 返回 {"posted": true, "merged": true}
```

### post.py 新增函数 (v9)

```python
# tools/post.py — v9 新增导入
from datetime import datetime, timezone

def _find_existing_phase_comment(api, pr_number, phase, sha):
    """查找 PR 上是否已存在同 phase + 同 SHA 的 Comment。返回 comment 对象或 None。"""
    try:
        comments = api.list_comments(pr_number)
    except GitHubAPIError:
        return None
    for c in comments:
        body = c.get("body", "")
        if f"<!-- review-phase: {phase} -->" in body and f"<!-- review-commit: {sha} -->" in body:
            return c
    return None

def _extract_findings_only(body: str) -> str:
    """从审查 body 中尝试提取纯 findings 部分。"""
    m = re.search(r"---REVIEW_START---(.*?)---REVIEW_END---", body, re.DOTALL)
    if m:
        return m.group(1).strip()
    lines = body.split("\n")
    while lines and (lines[0].strip().startswith("<!--") or lines[0].strip() == ""):
        lines.pop(0)
    return "\n".join(lines).strip()

def _merge_phase_comment(existing_body, new_body, new_author, phase, sha):
    """将新审查结果追加到已有 Comment body 后面。"""
    reviewer_count = 1
    mc = re.search(r"<!-- reviewer-count: (\d+) -->", existing_body)
    if mc:
        reviewer_count = int(mc.group(1)) + 1
    else:
        reviewer_count = 2

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    append_section = f"""

---
## 补充审查 — {new_author} ({timestamp})

{_extract_findings_only(new_body)}

<!-- reviewer-count: {reviewer_count} -->
<!-- merged: true -->
"""
    merged = re.sub(r"<!-- reviewer-count: \d+ -->\n?", "", existing_body)
    merged = re.sub(r"<!-- merged: true -->\n?", "", merged)
    merged += append_section
    return merged
```

### post_phase_result 修改 (v9)

```python
def tool_post_phase_result(args, config):
    # ... (前置逻辑不变: from_local_file, SHA_MISMATCH 校验, _ensure_markers, 截断, dry_run) ...

    api = get_api(config)

    # v9: CAS 追加 — 检测是否已有同 phase + 同 SHA 的 Comment
    existing_comment = _find_existing_phase_comment(api, pr, phase, sha)
    if existing_comment:
        new_author = config.get("github", {}).get("repo_owner", "unknown")
        merged_body = _merge_phase_comment(
            existing_comment.get("body", ""), body, new_author, phase, sha
        )
        try:
            resp = api.update_comment(existing_comment["id"], merged_body)
            return {"ok": True, "data": {
                "posted": True, "merged": True,
                "url": resp.get("html_url"),
                "merge_message": "检测到已有同 Phase + SHA 的审查结果，已自动合并追加"
            }}
        except GitHubAPIError as e:
            return {"ok": False, "error": {"code": "NETWORK_ERROR", "message": e.message}}

    try:
        resp = api.create_comment(pr, body)
        return {"ok": True, "data": {"posted": True, "merged": False,
            "url": resp.get("html_url"), "truncated": truncated}}
    except GitHubAPIError as e:
        return {"ok": False, "error": {"code": "NETWORK_ERROR", "message": e.message}}
```

---

### Task 1.3: post.py — post_phase_result + post_final_verdict

```python
# tools/post.py
import re, os, json
from github_api import GitHubAPI, GitHubAPIError
from tools._shared import get_api

PROJECT_ROOT = os.environ.get("PROJECT_ROOT", os.getcwd())

def register_post_tools(registry):
    registry["post_phase_result"] = {
        "schema": {"name": "post_phase_result", "description": "发布审查结果到 PR Comment",
            "inputSchema": {"type": "object",
                "properties": {"pr_number": {"type": "integer"}, "phase": {"type": "integer"},
                    "body": {"type": "string"}, "sha": {"type": "string"},
                    "dry_run": {"type": "boolean"}, "from_local_file": {"type": "boolean"}},
                "required": ["pr_number", "phase"]}},
        "handler": tool_post_phase_result,
    }
    registry["post_final_verdict"] = {
        "schema": {"name": "post_final_verdict", "description": "发布最终 PR Review",
            "inputSchema": {"type": "object",
                "properties": {"pr_number": {"type": "integer"},
                    "verdict": {"type": "string", "enum": ["request_changes", "approve", "comment"]},
                    "summary": {"type": "string"}},
                "required": ["pr_number", "verdict", "summary"]}},
        "handler": tool_post_final_verdict,
    }

# v7 修复: 添加导入 + _ensure_markers 辅助函数 + 删除重复的 tool_post_phase_result stub
def _ensure_markers(body: str, phase: int, sha: str) -> str:
    """确保 body 包含 phase marker 和 commit SHA marker"""
    if f"<!-- review-phase: {phase} -->" not in body:
        body = f"<!-- review-phase: {phase} -->\n<!-- review-commit: {sha} -->\n\n{body}"
    return body

def _truncate_utf8_safe(text, max_bytes=59000):
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes: return text, False
    truncated = encoded[:max_bytes]
    last_nl = truncated.rfind(b"\n")
    if last_nl > max_bytes // 2: truncated = truncated[:last_nl]
    return truncated.decode("utf-8", errors="replace"), True

def tool_post_phase_result(args, config):
    """v9: CAS 追加 — 检测已有 Comment → 追加合并而非 skip"""
    pr = args["pr_number"]; phase = args["phase"]
    body = args.get("body", ""); sha = args.get("sha", "unknown")
    dry_run = args.get("dry_run", False); from_local = args.get("from_local_file", False)

    if from_local:
        output_dir = config.get("output", {}).get("dir", "script/review-output")
        rf = os.path.join(PROJECT_ROOT, output_dir, f"PR-{pr}", f"phase{phase}-result.md")
        if not os.path.exists(rf):
            return {"ok": False, "error": {"code": "NO_LOCAL_RESULT", "message": f"本地文件不存在: {rf}"}}
        with open(rf) as f: body = f.read()
        sm = re.search(r"<!-- review-commit: ([a-f0-9]+) -->", body)
        sha = sm.group(1) if sm else sha

    existing = re.search(r"<!-- review-commit: ([a-f0-9]+) -->", body)
    if existing and existing.group(1) != sha:
        return {"ok": False, "error": {"code": "SHA_MISMATCH", "message": f"body SHA {existing.group(1)} != arg sha {sha}"}}

    body = _ensure_markers(body, phase, sha)
    orig_bytes = len(body.encode("utf-8")); truncated = False

    if orig_bytes > 60000:
        body, truncated = _truncate_utf8_safe(body)
        body += f"\n\n---\n⚠️ [超过 65K 限制已截断。完整报告见: script/review-output/PR-{pr}/phase{phase}-result.md]\n"

    if dry_run:
        return {"ok": True, "data": {"posted": False, "truncated": truncated,
            "original_bytes": orig_bytes, "warning": "dry_run"}}

    api = get_api(config)

    # v9: CAS 追加 — 检测是否已有同 phase + 同 SHA 的 Comment
    existing_comment = _find_existing_phase_comment(api, pr, phase, sha)
    if existing_comment:
        new_author = config.get("github", {}).get("repo_owner", "unknown")
        merged_body = _merge_phase_comment(
            existing_comment.get("body", ""), body, new_author, phase, sha
        )
        try:
            resp = api.update_comment(existing_comment["id"], merged_body)
            return {"ok": True, "data": {
                "posted": True, "merged": True,
                "url": resp.get("html_url"),
                "merge_message": "检测到已有同 Phase + SHA 的审查结果，已自动合并追加"
            }}
        except GitHubAPIError as e:
            return {"ok": False, "error": {"code": "NETWORK_ERROR", "message": e.message}}

    try:
        resp = api.create_comment(pr, body)
        return {"ok": True, "data": {"posted": True, "merged": False,
            "url": resp.get("html_url"), "truncated": truncated}}
    except GitHubAPIError as e:
        return {"ok": False, "error": {"code": "NETWORK_ERROR", "message": e.message}}

def tool_post_final_verdict(args, config):
    pr = args["pr_number"]; verdict = args["verdict"]; summary = args["summary"]
    valid = {"request_changes", "approve", "comment"}
    if verdict not in valid:
        return {"ok": False, "error": {"code": "INVALID_VERDICT", "message": f"verdict must be one of: {', '.join(sorted(valid))}, got: {verdict}"}}
    event = {"request_changes": "REQUEST_CHANGES", "approve": "APPROVE", "comment": "COMMENT"}[verdict]
    orig_bytes = len(summary.encode("utf-8"))

    if orig_bytes > 60000:
        summary, _ = _truncate_utf8_safe(summary)
        summary += f"\n\n---\n⚠️ [超过 65K 限制已截断。完整报告见本地。]\n"

    api = get_api(config)
    try:
        resp = api.create_review(pr, summary, event)
        return {"ok": True, "data": {"posted": True, "url": resp.get("html_url"), "truncated": orig_bytes > 60000}}
    except GitHubAPIError as e:
        return {"ok": False, "error": {"code": "NETWORK_ERROR", "message": e.message}}
```

---

## Phase 2-5: Skill + 测试 + 文档 + 集成

### Task 2.1: setup.sh — 引导脚本

```bash
#!/bin/bash
echo "=== Relay Review MCP Setup ==="
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
echo "Project root: $PROJECT_ROOT"

# 1. Python 依赖
echo "Installing Python deps..."
pip install -r "$(dirname "$0")/requirements.txt" 2>/dev/null || echo "⚠ pip install failed — please manually install requests"

# 2. MCP 配置生成
MCP_JSON=$(cat <<EOF
{
  "mcpServers": {
    "relay-review": {
      "command": "python3",
      "args": ["script/mcp-server/server.py"],
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
SKILL_SRC="$PROJECT_ROOT/script/mcp-server/relay-review-skill.md"
SKILL_DST="$HOME/.claude/skills/relay-review.md"
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
```

### Task 2.2: Skill 文件 (完整内容)

**Create:** `script/mcp-server/relay-review-skill.md`

```markdown
# Relay Review Skill

接力审查系统 — 通过 GitHub PR Comment 实现 Claude ↔ Codex 跨机器代码互审。

## 触发

"审查 PR #N" / "review PR #N" / "对 PR #N 做接力审查"

## 操作指令

### Phase 1: 代码审查

1. `get_pr_context(N)` — 验证 PR OPEN + 非 draft
2. `get_review_status(N)` — 检查 `next.phase == 1` + `next.ready == true`
   - 如果 `ready == false` + `reason == "phase_expired"`: 提示用户用 --force 重跑 Phase 1
3. Bash: `./review-pr.sh N --phase=1` — 执行审查 (内部 claude --bare -p)
4. `post_phase_result(N, phase=1, body=<result>, sha=<from_step_1>)` — 发布结果
   - 网络断开 → `post_phase_result(N, phase=1, from_local_file=true)`

### Phase 2: 接力复核

1. `get_review_status(N)` — 检查 Phase 1 状态
   - `next.reason == "phase_pending"` → 启动轮询等待 (见下方轮询策略)
2. `get_phase_result(N, phase=1)` — 获取 Phase 1 审查结果
   - `reason == "sha_mismatch"` → Phase 1 结果过期，提示用户重跑 Phase 1
3. Bash: `./review-pr.sh N --phase=2` — 执行复核 (内部 codex exec)
4. `post_phase_result(N, phase=2, body=<result>, sha=<current_sha>)`

### Phase 3: DB 验证

1. `get_review_status(N)` — 检查 `phase3_needed`
2. Bash: `./review-pr.sh N --phase=3` — DB 验证 (内部 claude -p + any-db MCP)
3. `post_phase_result(N, phase=3, body=<result>, sha=<current_sha>)`

### Final: 最终判定

1. `get_review_status(N)` — 确认所有 Phase 完成
2. `post_final_verdict(N, verdict=<auto>, summary=<generated>)`

## 错误恢复

| 错误场景 | 操作 |
|---------|------|
| PR diff 缓存过期 | `review-pr.sh N --phase=1 --force` |
| Phase 1 SHA 不匹配 | 提示用户 PR 被 rebase，需 --force 重跑 Phase 1 |
| `post_phase_result` 网络失败 | 用 `from_local_file=true` 重试 |
| Phase 3 不需要 DB 验证 | 跳过 Phase 3，直接 Final |
| Phase 1 重复执行防护 | PR comment 已有同 SHA 结果 → skip |

## 轮询等待策略

当 `get_review_status` 返回 `next.ready == false` + `next.reason == "phase_pending"` 时:

```
interval = 30  # 秒
max_checks = 60  # 30 分钟上限
backoff = 1.0  # 指数退避乘数 (每次翻倍, 上限 300s)

for check in 1..max_checks:
    sleep(interval * backoff)
    status = get_review_status(N)
    if status.next.ready: break  # 前置完成
    if status.next.reason == "phase_expired": 报错退出  # PR rebase

    # 403/429 → backoff *= 2 (max 300s)
    # 401/404 → 报错退出 (永久性错误)

if check >= max_checks: 超时报错
```
```

### Task 2.3: 测试 (10 handler 测试 + 集成测试)

```python
# tests/test_handlers.py — 关键测试覆盖 (v9: 21 → 30 个):
# 1. get_pr_context: 404 → PR_NOT_FOUND, 401 → AUTH_REQUIRED
# 2. _build_phase_status: SHA mismatch → expired, no comments → all pending
# 3. _compute_overall: Phase1_done+Phase2_pending → ready=true, reason=phase_pending
# 4. _derive_phase3_needed: body contains "SELECT *" → needed=true
# 5. get_phase_result: sha_mismatch → found=false, reason=sha_mismatch + mismatch object
# 6. post_phase_result: dry_run → posted=false
# 7. post_phase_result: body > 65K → truncated=true
# 8. post_phase_result: from_local_file + file_missing → NO_LOCAL_RESULT
# 9. post_final_verdict: invalid verdict → INVALID_VERDICT
# 10. post_final_verdict: body > 65K → truncated=true
# 11. v9: _build_phase_status multi_reviewers → contributors + reviewer_count + merged
# 12. v9: _find_existing_phase_comment: found / sha_mismatch
# 13. v9: _extract_findings_only: with/without markers
# 14. v9: _merge_phase_comment: 内容保留 + reviewer_count 递增
# 15. v9: post_phase_result CAS merge (mock) → merged=true, update_comment 被调用
# 16. v9: get_phase_result single → count=1
# 17. v9: get_phase_result multi → count=2, contributors=[bob, alice]
```

### Task 2.4: 集成测试 (5 个场景)

```bash
#!/bin/bash
# tests/integration.sh — MCP ↵ bash ↵ GitHub 端到端验证
# 前置: 真实 PR #42 存在于 GitHub

echo "=== 集成测试: Relay Review MCP ==="

# 场景 1: 完整 Phase 1 查询流程
echo "Test 1: get_pr_context + get_review_status"
context=$(echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_pr_context","arguments":{"pr_number":42}}}' | python3 server.py 2>/dev/null)
echo "$context" | python3 -c "import sys,json; r=json.load(sys.stdin); assert r['result']['content'][0]['text']['ok']" && echo "PASS" || echo "FAIL"

# 场景 2: 空 PR (无审查评论)
echo "Test 2: get_review_status on new PR"
status=$(echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_review_status","arguments":{"pr_number":42}}}' | python3 server.py 2>/dev/null)
echo "$status" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); assert d['data']['overall'] == 'not_started'" && echo "PASS" || echo "FAIL"

# 场景 3: post_phase_result (dry_run)
echo "Test 3: post_phase_result dry_run"
result=$(echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"post_phase_result","arguments":{"pr_number":42,"phase":1,"body":"test","sha":"abc123","dry_run":true}}}' | python3 server.py 2>/dev/null)
echo "$result" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); assert d['data']['posted'] == False" && echo "PASS" || echo "FAIL"

# 场景 4: post_final_verdict (invalid)
echo "Test 4: post_final_verdict with invalid verdict"
result=$(echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"post_final_verdict","arguments":{"pr_number":42,"verdict":"reject","summary":"bad"}}}' | python3 server.py 2>/dev/null)
echo "$result" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); assert d['ok'] == False" && echo "PASS" || echo "FAIL"

# 场景 5: 网络中断 (mock)
echo "Test 5: simulate network error"
# 需要断开 gh auth → 调 MCP → 确认返回 NETWORK_ERROR
echo "MANUAL: disconnect network and verify get_pr_context returns NETWORK_ERROR"
```

---

## 多机安装指南（v8 新增）

在另一台电脑上安装 Relay Review MCP Server：

### 1. 克隆仓库

```bash
git clone https://github.com/wang654993222/hsoft-data-manage.git
cd hsoft-data-manage
```

### 2. 安装 Python 依赖

```bash
pip install -r script/mcp-server/requirements.txt
```

### 3. 创建 GitHub Personal Access Token

1. 浏览器打开 https://github.com/settings/tokens/new
2. Note: `relay-review-mcp`
3. Expiration: No expiration
4. 勾选 `repo` (Full control of private repositories)
5. 点击 Generate token，复制生成的 `ghp_xxx...`

### 4. 创建 `.claude/mcp.json`

```json
{
  "mcpServers": {
    "relay-review": {
      "command": "python3",
      "args": ["script/mcp-server/server.py"],
      "cwd": "/path/to/hsoft-data-manage",
      "env": {
        "GITHUB_TOKEN": "你的ghp_token",
        "GITHUB_REPOSITORY": "wang654993222/hsoft-data-manage"
      }
    }
  }
}
```

### 5. 配置 `~/.claude/settings.json`

添加以下两项（三项配置缺一不可）：

```json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["relay-review"]
}
```

### 6. 重启 Claude Code Desktop

重启后输入 `/mcp` 确认 relay-review 显示在项目级配置中。

### 7. 验证

在对话中说：

> 用 get_pr_context 查询 PR #1 状态

应返回 PR 的元数据。

### 注意事项

- **不要**在 `settings.local.json` 中重复配置 `mcpServers` — 单一来源：`.claude/mcp.json`
- `post_final_verdict` 使用 `approve` 时需要审查者和 PR 作者是**不同人**（GitHub 限制：不能 approve 自己的 PR）
- 两台电脑用同一个 repo 的不同 GitHub 账号 → 实现跨机器接力审查

---

## 实施总结

| Phase | 任务 | 新建文件 | 预计工时 |
|-------|:---:|------|:---:|
| P0: 骨架 | 4 | server.py, config.py, github_api.py, parse_utils.py | 1.5h |
| P1: 核心 Tool | 3 | context.py, status.py, post.py | 2h |
| P2: Skill + 测试 | 2 | relay-review-skill.md, test_handlers.py | 2h |
| P3: Setup + 文档 | 2 | setup.sh, USAGE.md | 1h |
| P4: 集成验证 | 1 | — | 0.5h |
| **总计** | **14** | **19 个文件** | **~7h** |
| **v9 修订** | 3 | post.py, status.py, test_handlers.py (修改) | ~1h |
| **v10 修订** | 5 | gitee_api.py, config.py, _shared.py, test_gitee_api.py, test_config.py | ~1h |

### v10 Gitee 平台支持 — 新增文件与函数

| 文件 | 操作 | 行数 | 说明 |
|------|:---:|:---:|------|
| `gitee_api.py` | 新增 | ~60 | Gitee REST API v5 封装 |
| `config.py` `detect_platform()` | 新增 | ~15 | 双平台自动检测 |
| `config.py` `detect_token()` | 新增 | ~15 | 分平台 token 获取 |
| `tools/_shared.py` `get_api()` | 修改 | +4 | 平台路由 |
| `tests/test_gitee_api.py` | 新增 | ~60 | Gitee API 单元测试 |
| `tests/test_config.py` | 修改 | +70 | 双平台配置测试 |

### v9 并发审查合并 — 新增函数

| 函数 | 文件 | 行数 | 说明 |
|------|------|:---:|------|
| `_find_existing_phase_comment` | post.py | ~10 | CAS: 查找已有同 phase+SHA Comment |
| `_extract_findings_only` | post.py | ~10 | 提取纯 findings，去 header/footer |
| `_merge_phase_comment` | post.py | ~25 | 合并追加到已有 Comment |

### 实际新增文件（19 + 2 = 21 个）

```
script/mcp-server/
├── server.py              # JSON-RPC over stdin/stdout 入口
├── config.py              # 自动检测 GitHub/Gitee token/repo + env var 配置 (v10)
├── github_api.py          # GitHub REST API 封装 (requests, ~30 loc)
├── gitee_api.py           # Gitee REST API v5 封装 (v10 新增)
├── setup.sh               # 自动检测 + 生成 MCP 配置 + 复制 Skill
├── relay-review-skill.md  # 完整 Skill 文件 (Phase 1/2/3 操作 + 错误恢复 + 轮询)
├── USAGE.md               # 使用指南
├── requirements.txt       # requests>=2.31.0
├── requirements-test.txt  # pytest>=8.0.0
├── __init__.py
├── tools/
│   ├── __init__.py
│   ├── _shared.py         # get_api(config) 工厂 + 平台路由 (v10)
│   ├── context.py         # Tool 1: get_pr_context
│   ├── status.py          # Tool 2-3: get_review_status + get_phase_result
│   └── post.py            # Tool 4-5: post_phase_result + post_final_verdict
└── tests/
    ├── __init__.py
    ├── test_config.py     # config 双平台检测 (v10: GitHub + Gitee)
    ├── test_github_api.py # GitHub API 单元测试 (初始化/get_pr/分页)
    ├── test_gitee_api.py  # Gitee API 单元测试 (v10 新增)
    ├── test_handlers.py   # 30 个测试覆盖 17 handler 场景 (v9: 并发审查合并)
    └── integration.sh     # 5 场景集成测试 (manual)
```

### Git 提交历史（20 commits）

```
170fe95 feat: Gitee 平台支持 (方案A — 独立 API 封装)
ef1007c docs: 计划文档 v8→v9 — 并发审查合并方案回写
cea2cfa Add .claude/mcp.json — relay-review MCP server configuration
61bce0f docs: 添加 MCP 配置说明到 USAGE.md
54be6b5 status.py: improve error codes for get_review_status and get_phase_result
963f8b2 计划文档 v6→v7: 回写实施中发现的 5 个代码 bug
cb768be config.py: 补充 GITHUB_REPOSITORY=owner/repo 环境变量回退逻辑
5f8b191 Task 2.4 + 文档: 集成测试脚本 + USAGE.md
00cad9b Task 2.3: 测试 — 10 handler 单元测试 (全部通过)
40d59c2 Task 2.1 + 2.2: setup.sh 引导脚本 + Skill 文件
adb2468 Task 1.3: post.py — post_phase_result + post_final_verdict
27124af Task 1.2: status.py — get_review_status + get_phase_result
0e00769 Task 1.1: context.py — get_pr_context + _shared.py
32a8b86 Task 0.5: server.py — MCP JSON-RPC over stdin/stdout 入口
45bb998 Task 0.4: github_api.py — requests 实现 (~30 loc)
b526ffe Task 0.3: config.py — 自动检测 (env var + gh CLI, 无 YAML)
8c5b3cc Task 0.1: 项目结构初始化 + requirements
```
