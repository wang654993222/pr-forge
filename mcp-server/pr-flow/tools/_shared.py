# tools/_shared.py
# v11: 新增 run_git, truncate_utf8_safe, get_review_summary + 从 status.py 迁入的审查摘要逻辑
import os, re, subprocess
from github_api import GitHubAPI
from gitee_api import GiteeAPI

PROJECT_ROOT = os.environ.get("PROJECT_ROOT", os.getcwd())

def get_api(config: dict):
    """返回已认证的 API 实例（GitHubAPI 或 GiteeAPI），接口一致"""
    gh = config["github"]
    platform = config.get("platform", "github")
    if platform == "gitee":
        return GiteeAPI(gh["token"], gh["repo_owner"], gh["repo_name"])
    return GitHubAPI(gh["token"], gh["repo_owner"], gh["repo_name"])

def run_git(args, timeout=30, cwd=None):
    """执行 git 命令，返回 (returncode, stdout, stderr)"""
    if cwd is None: cwd = PROJECT_ROOT
    result = subprocess.run(["git"] + args, capture_output=True, text=True,
        timeout=timeout, cwd=cwd)
    return result.returncode, result.stdout.strip(), result.stderr.strip()

def truncate_utf8_safe(text, max_bytes=59000):
    """UTF-8 安全截断，在最后一个 \n 处切断"""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes: return text, False
    truncated = encoded[:max_bytes]
    last_nl = truncated.rfind(b"\n")
    if last_nl > max_bytes // 2: truncated = truncated[:last_nl]
    return truncated.decode("utf-8", errors="replace"), True

# ===== 审查摘要逻辑 (v11: 从 tools/status.py 迁移到 _shared.py) =====

def _build_phase_status(comments, current_sha):
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
                "reviewer_count": len(entries),
                "contributors": [e["author"] for e in entries],
                "merged": any("<!-- merged: true -->" in e.get("body", "") for e in entries),
            })
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
        overall, next_p, ready, reason = "in_progress", pending[0]["phase"], True, "phase_pending"
    return {"phases": phases, "overall": overall,
        "next": {"phase": next_p, "ready": ready, "reason": reason}}

def get_review_summary(api, pr_number, pr_data=None):
    """获取审查摘要供 merge_pr 预检使用。
    若 pr_data 已传入则复用，避免冗余 API 调用。
    返回 {overall, phases, next}
    """
    if pr_data is None:
        pr_data = api.get_pr(pr_number)
    current_sha = pr_data.get("head", {}).get("sha")
    comments = api.list_comments(pr_number)
    phases = _build_phase_status(comments, current_sha)
    return _compute_overall(phases)
