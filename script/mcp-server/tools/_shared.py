# tools/_shared.py
from github_api import GitHubAPI

def get_api(config: dict) -> GitHubAPI:
    return GitHubAPI(**config["github"])
