# tools/post.py
import re, os, json
from datetime import datetime, timezone
from github_api import GitHubAPI, GitHubAPIError
from gitee_api import GiteeAPIError
from tools._shared import get_api, truncate_utf8_safe

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

def _ensure_markers(body: str, phase: int, sha: str) -> str:
    """确保 body 包含 phase marker 和 commit SHA marker"""
    if f"<!-- review-phase: {phase} -->" not in body:
        body = f"<!-- review-phase: {phase} -->\n<!-- review-commit: {sha} -->\n\n{body}"
    return body

def _find_existing_phase_comment(api, pr_number, phase, sha):
    """查找 PR 上是否已存在同 phase + 同 SHA 的 Comment。返回 comment 对象或 None。"""
    try:
        comments = api.list_comments(pr_number)
    except (GitHubAPIError, GiteeAPIError):
        return None
    for c in comments:
        body = c.get("body", "")
        if f"<!-- review-phase: {phase} -->" in body and f"<!-- review-commit: {sha} -->" in body:
            return c
    return None

def _extract_findings_only(body: str) -> str:
    """从审查 body 中尝试提取纯 findings 部分，去掉三明治 header/footer。"""
    # 尝试提取 ---REVIEW_START--- 和 ---REVIEW_END--- 之间的内容
    m = re.search(r"---REVIEW_START---(.*?)---REVIEW_END---", body, re.DOTALL)
    if m:
        return m.group(1).strip()
    # 退而求其次：去掉开头和结尾的 marker 行
    lines = body.split("\n")
    # 移除前几行 marker（<!-- review-phase/commit -->）
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
        reviewer_count = 2  # 原来 1 份 + 现在 1 份

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    append_section = f"""

---
## 🔀 补充审查 — {new_author} ({timestamp})

{_extract_findings_only(new_body)}

<!-- reviewer-count: {reviewer_count} -->
<!-- merged: true -->
"""
    # 移除旧标记后重新插入
    merged = re.sub(r"<!-- reviewer-count: \d+ -->\n?", "", existing_body)
    merged = re.sub(r"<!-- merged: true -->\n?", "", merged)
    merged += append_section
    return merged

def tool_post_phase_result(args, config):
    pr = args["pr_number"]; phase = args["phase"]
    body = args.get("body", ""); sha = args.get("sha", "unknown")
    dry_run = args.get("dry_run", False); from_local = args.get("from_local_file", False)

    if from_local:
        output_dir = config.get("output", {}).get("dir", "mcp-server/pr-flow/review-output")
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
        body, truncated = truncate_utf8_safe(body)
        body += f"\n\n---\n⚠️ [超过 65K 限制已截断。完整报告见: mcp-server/pr-flow/review-output/PR-{pr}/phase{phase}-result.md]\n"

    if dry_run:
        return {"ok": True, "data": {"posted": False, "truncated": truncated, "original_bytes": orig_bytes, "warning": "dry_run"}}

    api = get_api(config)

    # CAS 追加: 检测是否已有同 phase + 同 SHA 的 Comment
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
        except (GitHubAPIError, GiteeAPIError) as e:
            return {"ok": False, "error": {"code": "NETWORK_ERROR", "message": e.message}}

    try:
        resp = api.create_comment(pr, body)
        return {"ok": True, "data": {"posted": True, "merged": False, "url": resp.get("html_url"), "truncated": truncated}}
    except (GitHubAPIError, GiteeAPIError) as e:
        return {"ok": False, "error": {"code": "NETWORK_ERROR", "message": e.message}}

def tool_post_final_verdict(args, config):
    pr = args["pr_number"]; verdict = args["verdict"]; summary = args["summary"]
    valid = {"request_changes", "approve", "comment"}
    if verdict not in valid:
        return {"ok": False, "error": {"code": "INVALID_VERDICT", "message": f"verdict must be one of: {', '.join(sorted(valid))}, got: {verdict}"}}
    event = {"request_changes": "REQUEST_CHANGES", "approve": "APPROVE", "comment": "COMMENT"}[verdict]
    orig_bytes = len(summary.encode("utf-8"))

    if orig_bytes > 60000:
        summary, _ = truncate_utf8_safe(summary)
        summary += f"\n\n---\n⚠️ [超过 65K 限制已截断。完整报告见本地。]\n"

    api = get_api(config)
    try:
        resp = api.create_review(pr, summary, event)
        return {"ok": True, "data": {"posted": True, "url": resp.get("html_url"), "truncated": orig_bytes > 60000}}
    except (GitHubAPIError, GiteeAPIError) as e:
        return {"ok": False, "error": {"code": "NETWORK_ERROR", "message": e.message}}
