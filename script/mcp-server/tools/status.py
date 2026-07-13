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
    # phases 现在是 list of list — 每个 phase 可以有多个审查者
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
            # 取最新 entry 的 sha 作为主 sha
            latest = entries[-1]
            expired = latest["sha"] and current_sha and latest["sha"] != current_sha
            entry = {
                "phase": p,
                "status": "expired" if expired else "done",
                "sha": latest["sha"],
                "author": latest["author"],
                "posted_at": latest["posted_at"],
                "url": latest["url"],
                "reason": "SHA mismatch" if expired else None,
                "reviewer_count": len(entries),
                "contributors": [e["author"] for e in entries],
                "merged": any("<!-- merged: true -->" in e.get("body", "") for e in entries),
            }
            result.append(entry)
        else:
            result.append({"phase": p, "status": "pending", "reviewer_count": 0})
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
        "next": {"phase": next_p, "ready": ready, "reason": reason}}

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
    pr = args["pr_number"]; phase = args["phase"]; api = get_api(config)
    try: pr_data = api.get_pr(pr); comments = api.list_comments(pr)
    except GitHubAPIError as e:
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
        # 如果有合并标记，用合并后的完整 body；否则取最新的
        primary = matching[0]  # reversed 顺序，最新在前
        return {"ok": True, "data": {
            "found": True, "reason": "ok",
            "count": len(matching),
            "merged": "<!-- merged: true -->" in primary["body"],
            "body": primary["body"],  # 合并后或最新的完整 body
            "sha": current_sha,
            "posted_at": primary["posted_at"],
            "author": primary["author"],
            "url": primary["url"],
            "contributors": [m["author"] for m in matching],
            "all_results": matching,  # 所有审查者的单独结果
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
