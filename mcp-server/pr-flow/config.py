# config.py — 自动检测 (env var + gh CLI, 无 YAML)
# v10: 支持 GitHub + Gitee 双平台自动检测
from typing import Optional
import os, subprocess

def detect_platform():
    """从环境变量或 git remote 检测平台: 'github' | 'gitee'"""
    # 1. 环境变量强制指定
    forced = os.environ.get("RELAY_REVIEW_PLATFORM", "").lower()
    if forced in ("github", "gitee"):
        return forced

    # 2. 根据 GITEE_TOKEN / GITEE_REPOSITORY 环境变量推断
    if os.environ.get("GITEE_TOKEN") or os.environ.get("GITEE_REPOSITORY"):
        return "gitee"

    # 3. 根据 git remote 自动检测
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            url = result.stdout.strip().lower()
            if "gitee.com" in url:
                return "gitee"
    except Exception:
        pass

    # 4. 默认 GitHub
    return "github"

def detect_token(platform: str) -> Optional[str]:
    """根据平台检测对应的 token"""
    if platform == "gitee":
        token = os.environ.get("GITEE_TOKEN")
        if token: return token
        # Gitee 也可以用通用 TOKEN 环境变量
        token = os.environ.get("RELAY_REVIEW_TOKEN")
        if token: return token
    else:
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
    """从 git remote 解析 owner/repo，支持 GitHub 和 Gitee"""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            url = result.stdout.strip()
            prefixes = [
                "https://github.com/", "git@github.com:",
                "https://gitee.com/", "git@gitee.com:",
            ]
            for prefix in prefixes:
                if prefix in url:
                    path = url.split(prefix)[-1].replace(".git", "")
                    parts = path.split("/")
                    if len(parts) >= 2: return parts[-2], parts[-1]
    except Exception: pass
    return None, None

def load_config() -> dict:
    platform = detect_platform()
    token = detect_token(platform)
    if not token:
        if platform == "gitee":
            raise RuntimeError(
                "Gitee token not found. Set GITEE_TOKEN env var."
            )
        else:
            raise RuntimeError(
                "GitHub token not found. Set GITHUB_TOKEN env var or run 'gh auth login'."
            )

    owner, repo = detect_repo_info()
    if (not owner or not repo):
        env_var = "GITEE_REPOSITORY" if platform == "gitee" else "GITHUB_REPOSITORY"
        if env_var in os.environ:
            parts = os.environ[env_var].split("/")
            if len(parts) >= 2: owner, repo = parts[-2], parts[-1]
    if not owner or not repo:
        hint = "GITEE_REPOSITORY=owner/repo" if platform == "gitee" else "GITHUB_REPOSITORY=owner/repo"
        raise RuntimeError(
            f"Could not detect repo from git remote. Set {hint}."
        )

    return {
        "github": {"token": token, "repo_owner": owner, "repo_name": repo},
        "platform": platform,
        "output": {"dir": os.environ.get("REVIEW_OUTPUT_DIR", "mcp-server/pr-flow/review-output")},
        "mcp": {"log_level": os.environ.get("REVIEW_LOG_LEVEL", "info")},
    }
