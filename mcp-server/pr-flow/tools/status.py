# tools/status.py
import re, os
from datetime import datetime, timezone
from github_api import GitHubAPI, GitHubAPIError
from gitee_api import GiteeAPIError
from tools._shared import get_api, _build_phase_status, _compute_overall

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
    except (GitHubAPIError, GiteeAPIError) as e:
        code = "AUTH_REQUIRED" if e.status_code in (401, 403) else \
               "PR_NOT_FOUND" if e.status_code == 404 else "NETWORK_ERROR"
        return {"ok": False, "error": {"code": code, "message": e.message}}
    current_sha = pr_data.get("head", {}).get("sha")
    phases = _build_phase_status(comments, current_sha)
    return {"ok": True, "data": _compute_overall(phases)}

def _derive_phase3_needed(phases):
    """从 Phase 1/2 结果推导是否需要 Phase 3"""
    for p in [1, 2]:
        phase = next((x for x in phases if x["phase"] == p), None)
        if phase and phase["status"] == "done" and phase.get("body"):
            body = phase.get("body", "")
            if re.search(r"(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|N\+1|全表扫描|索引|EXPLAIN)", body, re.I):
                return {"checked": True, "needed": True, "confidence": "high"}
    return {"checked": True, "needed": False, "confidence": "high"}

def tool_get_phase_result(args, config):
    pr = args["pr_number"]; phase = args["phase"]; api = get_api(config)
    try: pr_data = api.get_pr(pr); comments = api.list_comments(pr)
    except (GitHubAPIError, GiteeAPIError) as e:
        code = "AUTH_REQUIRED" if e.status_code in (401, 403) else \
               "PR_NOT_FOUND" if e.status_code == 404 else "NETWORK_ERROR"
        return {"ok": False, "error": {"code": code, "message": e.message}}
    current_sha = pr_data.get("head", {}).get("sha")

    # 收集所有匹配当前 SHA + phase 的 Comment（支持多人并发审查）
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
            "count": len(matching),
            "merged": "<!-- merged: true -->" in primary["body"],
            "body": primary["body"],
            "sha": current_sha,
            "posted_at": primary["posted_at"],
            "author": primary["author"],
            "url": primary["url"],
            "contributors": [m["author"] for m in matching],
            "all_results": matching,
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
