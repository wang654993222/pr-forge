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
    if not owner or not repo:
        raise RuntimeError(
            "Could not detect GitHub repo from git remote. Set GITHUB_REPOSITORY=owner/repo."
        )
    return {
        "github": {"token": token, "repo_owner": owner, "repo_name": repo},
        "output": {"dir": os.environ.get("REVIEW_OUTPUT_DIR", "script/review-output")},
        "mcp": {"log_level": os.environ.get("REVIEW_LOG_LEVEL", "info")},
    }
