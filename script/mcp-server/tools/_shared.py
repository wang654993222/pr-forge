# tools/_shared.py
# v10: 根据 platform 选择 GitHubAPI 或 GiteeAPI
from github_api import GitHubAPI
from gitee_api import GiteeAPI

def get_api(config: dict):
    """返回已认证的 API 实例（GitHubAPI 或 GiteeAPI），接口一致"""
    gh = config["github"]
    platform = config.get("platform", "github")
    if platform == "gitee":
        return GiteeAPI(gh["token"], gh["repo_owner"], gh["repo_name"])
    return GitHubAPI(gh["token"], gh["repo_owner"], gh["repo_name"])
