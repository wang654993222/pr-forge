# tools/context.py
import os
from github_api import GitHubAPI, GitHubAPIError
from gitee_api import GiteeAPIError
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
    except (GitHubAPIError, GiteeAPIError) as e:
        code = "AUTH_REQUIRED" if e.status_code in (401, 403) else \
               "PR_NOT_FOUND" if e.status_code == 404 else "NETWORK_ERROR"
        return {"ok": False, "error": {"code": code, "message": e.message}}
