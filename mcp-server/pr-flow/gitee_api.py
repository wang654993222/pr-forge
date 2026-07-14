# gitee_api.py — Gitee REST API v5 封装
# 与 github_api.py 接口完全一致，方便 tools/ 层无感切换
import base64, requests, json
from urllib.parse import urlencode

class GiteeAPIError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code; self.message = message
        super().__init__(f"Gitee API Error ({status_code}): {message}")

class GiteeAPI:
    def __init__(self, token, owner, repo):
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json;charset=UTF-8",
            "User-Agent": "pr-flow/2.0",
        })
        self.token = token
        self.base = f"https://gitee.com/api/v5/repos/{owner}/{repo}"

    def _request(self, method, path, raw=False, **kwargs):
        url = f"{self.base}/{path}"
        # Gitee 用 query param 认证，不是 header
        if "?" in url:
            url += f"&access_token={self.token}"
        else:
            url += f"?access_token={self.token}"
        # 移除 kwargs 中可能冲突的 params
        kwargs.pop("params", None)
        resp = self.session.request(method, url, timeout=30, **kwargs)
        if not resp.ok:
            msg = resp.text[:200]
            ct = resp.headers.get("Content-Type", "")
            if "application/json" in ct:
                try: msg = resp.json().get("message", resp.text[:200])
                except (ValueError, KeyError): pass
            raise GiteeAPIError(resp.status_code, msg)
        if raw: return resp.text
        return resp.json() if resp.text else {}

    def get_pr(self, pr_number):
        return self._request("GET", f"pulls/{pr_number}")

    def list_comments(self, pr_number, per_page=100):
        all_data, page = [], 1
        while True:
            data = self._request("GET",
                f"pulls/{pr_number}/comments?per_page={per_page}&page={page}")
            if not isinstance(data, list): break
            all_data.extend(data)
            if len(data) < per_page: break
            page += 1
        return all_data

    def create_comment(self, pr_number, body):
        return self._request("POST", f"pulls/{pr_number}/comments", json={"body": body})

    def update_comment(self, comment_id, body):
        return self._request("PATCH", f"pulls/comments/{comment_id}", json={"body": body})

    def create_review(self, pr_number, body, event="COMMENT"):
        """Gitee 没有 PR Review API，降级为发布 Comment。
        event 参数保留以保持接口兼容，但实际只发布 Comment。"""
        return self.create_comment(pr_number, body)

    def merge_pr(self, pr_number, merge_method="merge", delete_branch=False):
        """Gitee 独有：直接合并 PR"""
        return self._request("PUT", f"pulls/{pr_number}/merge",
            json={"merge_method": merge_method, "prune_source_branch": delete_branch})

    # v11: 新增方法
    def get_pr_diff(self, pr_number):
        return self._request("GET", f"pulls/{pr_number}.diff", raw=True)

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
