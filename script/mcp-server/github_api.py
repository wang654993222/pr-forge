# github_api.py
import requests, json

class GitHubAPIError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code; self.message = message
        super().__init__(f"GitHub API Error ({status_code}): {message}")

class GitHubAPI:
    def __init__(self, token, owner, repo):
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "relay-review-mcp/1.0",
        })
        self.base = f"https://api.github.com/repos/{owner}/{repo}"

    def _request(self, method, path, **kwargs):
        url = f"{self.base}/{path}"
        resp = self.session.request(method, url, timeout=30, **kwargs)
        if not resp.ok:
            raise GitHubAPIError(resp.status_code, resp.json().get("message", resp.text))
        return resp.json() if resp.text else {}

    def get_pr(self, pr_number):      return self._request("GET", f"pulls/{pr_number}")
    def list_comments(self, pr_number, per_page=100):
        all_data, page = [], 1
        while True:
            data = self._request("GET", f"issues/{pr_number}/comments?per_page={per_page}&page={page}")
            if not isinstance(data, list): break
            all_data.extend(data)
            if len(data) < per_page: break
            page += 1
        return all_data
    def create_comment(self, pr_number, body):
        return self._request("POST", f"issues/{pr_number}/comments", json={"body": body})
    def update_comment(self, comment_id, body):
        return self._request("PATCH", f"issues/comments/{comment_id}", json={"body": body})
    def create_review(self, pr_number, body, event="COMMENT"):
        return self._request("POST", f"pulls/{pr_number}/reviews", json={"body": body, "event": event})
