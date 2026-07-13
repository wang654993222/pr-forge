# tools/_shared.py
from github_api import GitHubAPI

def get_api(config: dict) -> GitHubAPI:
    return GitHubAPI(config["github"]["token"], config["github"]["repo_owner"], config["github"]["repo_name"])
