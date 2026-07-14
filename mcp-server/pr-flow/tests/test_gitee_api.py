# tests/test_gitee_api.py
from unittest.mock import patch, MagicMock
from gitee_api import GiteeAPI, GiteeAPIError


def test_gitee_api_init():
    api = GiteeAPI("token123", "owner", "repo")
    assert "gitee.com/api/v5/repos/owner/repo" in api.base
    assert api.token == "token123"


@patch.object(GiteeAPI, '_request')
def test_get_pr(mock_request):
    mock_request.return_value = {"number": 1, "title": "test PR"}
    api = GiteeAPI("t", "o", "r")
    result = api.get_pr(1)
    assert result["number"] == 1
    mock_request.assert_called_with("GET", "pulls/1")


@patch.object(GiteeAPI, '_request')
def test_list_comments_pagination(mock_request):
    mock_request.side_effect = [
        [{"id": i} for i in range(100)],
        [{"id": i} for i in range(100, 150)],
    ]
    api = GiteeAPI("t", "o", "r")
    result = api.list_comments(1)
    assert len(result) == 150
    assert mock_request.call_count == 2


@patch.object(GiteeAPI, '_request')
def test_create_review_downgrade_to_comment(mock_request):
    """Gitee 没有 PR Review API，create_review 应降级为 create_comment"""
    mock_request.return_value = {"id": 99, "body": "review as comment"}
    api = GiteeAPI("t", "o", "r")
    result = api.create_review(1, "LGTM", "APPROVE")
    assert result["id"] == 99
    # 验证调用的是 pulls/{n}/comments，不是 pulls/{n}/reviews
    call_args = mock_request.call_args[0]
    assert "comments" in call_args[1]  # path contains "comments"
    assert "review" not in call_args[1]  # path does NOT contain "reviews"


@patch.object(GiteeAPI, '_request')
def test_merge_pr(mock_request):
    """Gitee 独有：直接合并 PR"""
    mock_request.return_value = {"merged": True}
    api = GiteeAPI("t", "o", "r")
    result = api.merge_pr(1, merge_method="squash", delete_branch=True)
    assert result["merged"] == True
    mock_request.assert_called_with("PUT", "pulls/1/merge",
        json={"merge_method": "squash", "prune_source_branch": True})


def test_gitee_api_error():
    err = GiteeAPIError(404, "PR not found")
    assert err.status_code == 404
    assert "PR not found" in str(err)
