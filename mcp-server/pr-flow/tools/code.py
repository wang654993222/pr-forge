# tools/code.py — v11: 4 个新 Tool: get_pr_diff, get_file_content, commit_and_push, merge_pr
import os
from github_api import GitHubAPIError
from gitee_api import GiteeAPIError
from tools._shared import get_api, run_git, truncate_utf8_safe, PROJECT_ROOT, get_review_summary

def register_code_tools(registry):
    registry["get_pr_diff"] = {
        "schema": {"name": "get_pr_diff", "description": "获取 PR unified diff",
            "inputSchema": {"type": "object",
                "properties": {
                    "pr_number": {"type": "integer"},
                    "max_bytes": {"type": "integer", "description": "最大返回字节数，默认 150000"}
                },
                "required": ["pr_number"]}},
        "handler": tool_get_pr_diff,
    }
    registry["get_file_content"] = {
        "schema": {"name": "get_file_content", "description": "获取仓库文件内容",
            "inputSchema": {"type": "object",
                "properties": {
                    "path": {"type": "string", "description": "文件路径（相对于仓库根目录）"},
                    "ref": {"type": "string", "description": "分支名或 commit SHA"}
                },
                "required": ["path"]}},
        "handler": tool_get_file_content,
    }
    registry["commit_and_push"] = {
        "schema": {"name": "commit_and_push", "description": "提交修复并推送到 PR 分支",
            "inputSchema": {"type": "object",
                "properties": {
                    "message": {"type": "string", "description": "Commit 消息"},
                    "branch": {"type": "string", "description": "目标远程分支（PR head_ref）"},
                    "pr_number": {"type": "integer", "description": "PR 编号，传此参数时校验 branch 是否匹配"},
                    "files": {"type": "array", "items": {"type": "string"}, "description": "要提交的文件列表，不传则暂存所有变更"},
                    "dry_run": {"type": "boolean", "description": "仅预览，不实际提交"}
                },
                "required": ["message", "branch"]}},
        "handler": tool_commit_and_push,
    }
    registry["merge_pr"] = {
        "schema": {"name": "merge_pr", "description": "合并 PR 到目标分支",
            "inputSchema": {"type": "object",
                "properties": {
                    "pr_number": {"type": "integer"},
                    "merge_method": {"type": "string", "enum": ["merge", "squash", "rebase"], "description": "合并方式，默认 merge"},
                    "delete_branch": {"type": "boolean", "description": "合并后删除源分支（仅 Gitee 支持）"},
                    "dry_run": {"type": "boolean", "description": "仅检查可合并性"}
                },
                "required": ["pr_number"]}},
        "handler": tool_merge_pr,
    }

# ===== Tool 1: get_pr_diff =====

def tool_get_pr_diff(args, config):
    pr = args["pr_number"]; max_bytes = args.get("max_bytes", 150000)
    api = get_api(config)
    try: diff = api.get_pr_diff(pr)
    except (GitHubAPIError, GiteeAPIError) as e:
        code = "AUTH_REQUIRED" if e.status_code in (401, 403) else \
               "PR_NOT_FOUND" if e.status_code == 404 else "NETWORK_ERROR"
        return {"ok": False, "error": {"code": code, "message": e.message}}

    total_bytes = len(diff.encode("utf-8")); truncated = False; warning = None
    if total_bytes > max_bytes:
        diff, truncated = truncate_utf8_safe(diff, max_bytes)
        warning = "diff 超过大小限制已截断，请使用 get_file_content 获取完整文件内容"

    return {"ok": True, "data": {"diff": diff, "total_bytes": total_bytes,
        "truncated": truncated, "warning": warning}}

# ===== Tool 2: get_file_content =====

def tool_get_file_content(args, config):
    path = args["path"]; ref = args.get("ref")
    # 防御性路径校验
    if ".." in path:
        return {"ok": False, "error": {"code": "INVALID_PATH", "message": f"路径包含非法字符: {path}"}}

    api = get_api(config)
    try: result = api.get_file_content(path, ref)
    except (GitHubAPIError, GiteeAPIError) as e:
        code = "FILE_NOT_FOUND" if e.status_code == 404 else \
               "AUTH_REQUIRED" if e.status_code in (401, 403) else "NETWORK_ERROR"
        return {"ok": False, "error": {"code": code, "message": e.message}}

    content = result["content"]; binary = result["binary"]; size_bytes = len(content.encode("utf-8")) if not binary else len(content)
    truncated = False; warning = None

    if not binary and size_bytes > 500000:
        content, truncated = truncate_utf8_safe(content, 500000)
        warning = "文件超过 500KB 已截断"

    return {"ok": True, "data": {"path": path, "ref": ref, "content": content,
        "size_bytes": size_bytes, "binary": binary, "truncated": truncated, "warning": warning}}

# ===== Tool 3: commit_and_push =====

def tool_commit_and_push(args, config):
    message = args["message"]; branch = args["branch"]
    pr_number = args.get("pr_number")
    files = args.get("files")
    dry_run = args.get("dry_run", False)

    # 0. 检查 git identity（优先环境变量，再检查 git config）
    has_name = os.environ.get("GIT_AUTHOR_NAME") or os.environ.get("GIT_COMMITTER_NAME")
    has_email = os.environ.get("GIT_AUTHOR_EMAIL") or os.environ.get("GIT_COMMITTER_EMAIL")
    if not has_name:
        rc, out, err = run_git(["config", "user.name"])
        if rc == 0 and out: has_name = out
    if not has_email:
        rc, out, err = run_git(["config", "user.email"])
        if rc == 0 and out: has_email = out
    if not has_name:
        return {"ok": False, "error": {"code": "GIT_IDENTITY_MISSING",
            "message": "git user.name 未配置。请设置: git config user.name 或 GIT_AUTHOR_NAME 环境变量"}}
    if not has_email:
        return {"ok": False, "error": {"code": "GIT_IDENTITY_MISSING",
            "message": "git user.email 未配置。请设置: git config user.email 或 GIT_AUTHOR_EMAIL 环境变量"}}

    # 1. 如果传了 pr_number，校验 branch
    if pr_number is not None:
        api = get_api(config)
        try: pr_data = api.get_pr(pr_number)
        except (GitHubAPIError, GiteeAPIError) as e:
            code = "AUTH_REQUIRED" if e.status_code in (401, 403) else \
                   "PR_NOT_FOUND" if e.status_code == 404 else "NETWORK_ERROR"
            return {"ok": False, "error": {"code": code, "message": e.message}}
        head_ref = pr_data.get("head", {}).get("ref", "")
        if branch != head_ref:
            return {"ok": False, "error": {
                "code": "BRANCH_MISMATCH",
                "message": f"branch '{branch}' 与 PR head_ref '{head_ref}' 不匹配"}}

    # 2. git status
    rc, status_out, err = run_git(["status", "--porcelain"])
    if rc != 0:
        return {"ok": False, "error": {"code": "GIT_ERROR", "message": f"git status failed: {err}"}}
    if not status_out:
        return {"ok": False, "error": {"code": "NO_CHANGES", "message": "没有需要提交的修改"}}

    changed_files = [line[3:] for line in status_out.split("\n") if line.strip()]

    # 3. dry_run
    if dry_run:
        return {"ok": True, "data": {"committed": False, "files": changed_files,
            "status_porcelain": status_out, "warning": "dry_run"}}

    # 4. git add
    warning = None
    if files:
        for f in files:
            rc, _, err = run_git(["add", f])
            if rc != 0:
                return {"ok": False, "error": {"code": "GIT_ERROR",
                    "message": f"git add {f} failed: {err}"}}
    else:
        rc, _, err = run_git(["add", "-A"])
        if rc != 0:
            return {"ok": False, "error": {"code": "GIT_ERROR", "message": f"git add -A failed: {err}"}}
        warning = "使用 git add -A 暂存了所有变更，请确认范围正确"

    # 5. git commit
    rc, _, err = run_git(["commit", "-m", message])
    if rc != 0:
        return {"ok": False, "error": {"code": "GIT_ERROR", "message": f"git commit failed: {err}"}}

    # 6. git rev-parse HEAD
    rc, sha, err = run_git(["rev-parse", "HEAD"])
    if rc != 0:
        return {"ok": False, "error": {"code": "GIT_ERROR", "message": f"git rev-parse failed: {err}"}}

    # 7. git push
    rc, _, err = run_git(["push", "origin", f"HEAD:{branch}"], timeout=60)
    if rc != 0:
        # 不撤销 commit，保留本地状态
        return {"ok": False, "error": {"code": "GIT_ERROR",
            "message": f"git push failed (commit 已保留在本地, sha={sha}): {err}"}}

    return {"ok": True, "data": {"committed": True, "sha": sha, "files": changed_files,
        "status_porcelain": status_out, "message": message, "branch": branch, "warning": warning}}

# ===== Tool 4: merge_pr =====

def tool_merge_pr(args, config):
    pr = args["pr_number"]; merge_method = args.get("merge_method", "merge")
    delete_branch = args.get("delete_branch", False); dry_run = args.get("dry_run", False)
    api = get_api(config)
    platform = config.get("platform", "github")

    # 获取 PR 信息
    try: pr_data = api.get_pr(pr)
    except (GitHubAPIError, GiteeAPIError) as e:
        code = "AUTH_REQUIRED" if e.status_code in (401, 403) else \
               "PR_NOT_FOUND" if e.status_code == 404 else "NETWORK_ERROR"
        return {"ok": False, "error": {"code": code, "message": e.message}}

    # 审查完成检查（复用 pr_data，避免冗余 get_pr）
    try: summary = get_review_summary(api, pr, pr_data)
    except (GitHubAPIError, GiteeAPIError) as e:
        return {"ok": False, "error": {"code": "NETWORK_ERROR",
            "message": f"审查状态查询失败: {e.message}"}}

    if summary["overall"] != "complete":
        return {"ok": False, "error": {
            "code": "MERGE_NOT_ALLOWED",
            "message": f"审查未完成，当前状态: {summary['overall']}"}}

    # dry_run 检查
    if dry_run:
        mergeable = pr_data.get("mergeable", None)
        mergeable_state = pr_data.get("mergeable_state", None)
        mergeable_note = None; mergeable_state_note = None
        if platform == "gitee":
            if mergeable is None:
                mergeable_note = "mergeable 字段 Gitee API 不返回，请使用 dry_run=false 尝试合并"
            mergeable_state_note = "mergeable_state 仅 GitHub 平台可用"
        db_warning = None
        if platform == "github" and delete_branch:
            db_warning = "delete_branch 参数仅 Gitee 平台生效，已被忽略"
        return {"ok": True, "data": {
            "merged": False, "warning": db_warning or "dry_run",
            "mergeable": mergeable, "mergeable_note": mergeable_note,
            "mergeable_state": mergeable_state, "mergeable_state_note": mergeable_state_note,
            "review_status": summary["overall"],
            "base_branch": pr_data.get("base", {}).get("ref"),
            "head_sha": pr_data.get("head", {}).get("sha"),
        }}

    # 实际合并
    try:
        if platform == "gitee":
            resp = api.merge_pr(pr, merge_method=merge_method, delete_branch=delete_branch)
        else:
            db_warning = None
            if delete_branch:
                db_warning = "delete_branch 参数仅 Gitee 平台生效，已被忽略"
            resp = api.merge_pr(pr, merge_method=merge_method)
        return {"ok": True, "data": {
            "merged": True,
            "message": resp.get("message", "Pull Request successfully merged"),
            "sha": resp.get("sha", ""),
            "warning": db_warning if platform != "gitee" and delete_branch else None,
        }}
    except (GitHubAPIError, GiteeAPIError) as e:
        if e.status_code == 409:
            return {"ok": False, "error": {"code": "MERGE_CONFLICT", "message": e.message}}
        if e.status_code in (405, 422):
            return {"ok": False, "error": {"code": "MERGE_NOT_ALLOWED", "message": e.message}}
        return {"ok": False, "error": {"code": "NETWORK_ERROR", "message": e.message}}
