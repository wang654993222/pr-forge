# github_api.py
import base64, requests, json

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
            "User-Agent": "pr-flow/2.0",
        })
        self.base = f"https://api.github.com/repos/{owner}/{repo}"

    def _request(self, method, path, raw=False, **kwargs):
        url = f"{self.base}/{path}"
        resp = self.session.request(method, url, timeout=30, **kwargs)
        if not resp.ok:
            msg = resp.text[:200]
            ct = resp.headers.get("Content-Type", "")
            if "application/json" in ct:
                try: msg = resp.json().get("message", resp.text[:200])
                except (ValueError, KeyError): pass
            raise GitHubAPIError(resp.status_code, msg)
        if raw: return resp.text
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

    # v11: 新增方法
    def get_pr_diff(self, pr_number):
        return self._request("GET", f"pulls/{pr_number}", raw=True,
            headers={"Accept": "application/vnd.github.v3.diff"})

    def get_file_content(self, path, ref=None):
        p = f"contents/{path}"
        if ref: p += f"?ref={ref}"
        data = self._request("GET", p)
        if data.get("encoding") == "base64" and data.get("content"):
            decoded = base64.b64decode(data["content"])
            try:
                return {"content": decoded.decode("utf-8"), "binary": False}
            except UnicodeDecodeError:
                return {"content": data["content"], "binary": True}
        return {"content": data.get("content", ""), "binary": False}

    def merge_pr(self, pr_number, merge_method="merge",
                 commit_title=None, commit_message=None):
        body = {"merge_method": merge_method}
        if commit_title: body["commit_title"] = commit_title
        if commit_message: body["commit_message"] = commit_message
        return self._request("PUT", f"pulls/{pr_number}/merge", json=body)
