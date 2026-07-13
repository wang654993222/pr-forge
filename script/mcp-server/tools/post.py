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
        return {"ok": True, "data": {"posted": False, "truncated": truncated, "original_bytes": orig_bytes, "warning": "dry_run"}}

    api = get_api(config)
    try:
        resp = api.create_comment(pr, body)
        return {"ok": True, "data": {"posted": True, "url": resp.get("html_url"), "truncated": truncated}}
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
