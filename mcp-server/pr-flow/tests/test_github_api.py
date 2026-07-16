# tests/test_github_api.py
from unittest.mock import patch, MagicMock
from github_api import GitHubAPI, GitHubAPIError

def test_github_api_init():
    api = GitHubAPI("token", "owner", "repo")
    assert api.base == "https://api.github.com/repos/owner/repo"
    assert "Bearer token" in api.session.headers.get("Authorization", "")

@patch.object(GitHubAPI, '_request')
def test_get_pr(mock_request):
    mock_request.return_value = {"number": 1, "title": "test"}
    api = GitHubAPI("t", "o", "r")
    result = api.get_pr(1)
    assert result["number"] == 1
    mock_request.assert_called_with("GET", "pulls/1")

@patch.object(GitHubAPI, '_request')
def test_list_comments_pagination(mock_request):
    # first page full, second page partial
    mock_request.side_effect = [
        [{"id": i} for i in range(100)],
        [{"id": i} for i in range(100, 150)],
    ]
    api = GitHubAPI("t", "o", "r")
    result = api.list_comments(1)
    assert len(result) == 150
    assert mock_request.call_count == 2
