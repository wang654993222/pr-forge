# tests/test_code.py — v11 新增: code.py 单元测试 (13 用例)
from unittest.mock import patch, MagicMock
from tools.code import tool_get_pr_diff, tool_get_file_content, tool_commit_and_push, tool_merge_pr


# ===== get_pr_diff =====

@patch('tools.code.get_api')
def test_get_pr_diff_ok(mock_get_api):
    api = MagicMock(); api.get_pr_diff.return_value = "diff --git a/x b/x\n+line"
    mock_get_api.return_value = api
    result = tool_get_pr_diff({"pr_number": 1}, {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}})
    assert result["ok"] == True
    assert "+line" in result["data"]["diff"]
    assert result["data"]["truncated"] == False


@patch('tools.code.get_api')
def test_get_pr_diff_truncated(mock_get_api):
    api = MagicMock(); api.get_pr_diff.return_value = "x" * 200000
    mock_get_api.return_value = api
    result = tool_get_pr_diff({"pr_number": 1, "max_bytes": 50000}, {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}})
    assert result["ok"] == True
    assert result["data"]["truncated"] == True
    assert result["data"]["total_bytes"] > 50000


# ===== get_file_content =====

@patch('tools.code.get_api')
def test_get_file_content_ok(mock_get_api):
    api = MagicMock(); api.get_file_content.return_value = {"content": "package com.example;", "binary": False}
    mock_get_api.return_value = api
    result = tool_get_file_content({"path": "src/Foo.java", "ref": "feature/x"}, {})
    assert result["ok"] == True
    assert result["data"]["binary"] == False
    assert "package" in result["data"]["content"]


@patch('tools.code.get_api')
def test_get_file_content_binary(mock_get_api):
    api = MagicMock(); api.get_file_content.return_value = {"content": "iVBORw0KGg...", "binary": True}
    mock_get_api.return_value = api
    result = tool_get_file_content({"path": "img/logo.png"}, {})
    assert result["ok"] == True
    assert result["data"]["binary"] == True


def test_get_file_content_invalid_path():
    result = tool_get_file_content({"path": "../etc/passwd"}, {})
    assert result["ok"] == False
    assert result["error"]["code"] == "INVALID_PATH"


# ===== commit_and_push =====

@patch('tools.code.run_git')
def test_commit_and_push_dry_run(mock_git):
    mock_git.side_effect = [
        (0, "Test User", ""),     # git config user.name
        (0, "test@test.com", ""), # git config user.email
        (0, "M  src/Foo.java\n", ""),  # git status
    ]
    result = tool_commit_and_push(
        {"message": "fix", "branch": "feature/x", "dry_run": True},
        {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}}
    )
    assert result["ok"] == True
    assert result["data"]["committed"] == False
    assert result["data"]["warning"] == "dry_run"


@patch('tools.code.run_git')
def test_commit_and_push_no_changes(mock_git):
    mock_git.side_effect = [
        (0, "Test User", ""),     # git config user.name
        (0, "test@test.com", ""), # git config user.email
        (0, "", ""),               # git status (empty)
    ]
    result = tool_commit_and_push(
        {"message": "fix", "branch": "feature/x"},
        {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}}
    )
    assert result["ok"] == False
    assert result["error"]["code"] == "NO_CHANGES"


@patch('tools.code.run_git')
def test_commit_and_push_success(mock_git):
    mock_git.side_effect = [
        (0, "Test User", ""),              # git config user.name
        (0, "test@test.com", ""),          # git config user.email
        (0, "M  src/Foo.java\n", ""),      # git status
        (0, "", ""),                        # git add -A
        (0, "", ""),                        # git commit
        (0, "abc123def456", ""),         # git rev-parse HEAD
        (0, "", ""),                        # git push
    ]
    result = tool_commit_and_push(
        {"message": "fix: review", "branch": "feature/x"},
        {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}}
    )
    assert result["ok"] == True
    assert result["data"]["committed"] == True
    assert result["data"]["sha"] == "abc123def456"
    assert "使用 git add -A" in result["data"]["warning"]  # 未传 files 参数


@patch('tools.code.run_git')
def test_commit_and_push_with_files(mock_git):
    mock_git.side_effect = [
        (0, "Test User", ""),              # git config user.name
        (0, "test@test.com", ""),          # git config user.email
        (0, "M  src/Foo.java\n", ""),      # git status
        (0, "", ""),                        # git add Foo.java
        (0, "", ""),                        # git commit
        (0, "abc123\n", ""),               # git rev-parse HEAD
        (0, "", ""),                        # git push
    ]
    result = tool_commit_and_push(
        {"message": "fix", "branch": "feature/x", "files": ["src/Foo.java"]},
        {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}}
    )
    assert result["ok"] == True
    assert result["data"]["warning"] is None  # 传了 files，无 add -A warning


@patch('tools.code.run_git')
def test_commit_and_push_push_failed(mock_git):
    mock_git.side_effect = [
        (0, "Test User", ""),              # git config user.name
        (0, "test@test.com", ""),          # git config user.email
        (0, "M  src/Foo.java\n", ""),      # git status
        (0, "", ""),                        # git add -A
        (0, "", ""),                        # git commit
        (0, "abc123\n", ""),               # git rev-parse HEAD
        (1, "", "rejected"),               # git push FAILED
    ]
    result = tool_commit_and_push(
        {"message": "fix", "branch": "feature/x"},
        {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}}
    )
    assert result["ok"] == False
    assert result["error"]["code"] == "GIT_ERROR"
    assert "abc123" in result["error"]["message"]  # commit SHA 保留在错误消息中


@patch('tools.code.get_api')
@patch('tools.code.run_git')
def test_commit_and_push_branch_mismatch(mock_git, mock_get_api):
    mock_git.side_effect = [
        (0, "Test User", ""),     # git config user.name
        (0, "test@test.com", ""), # git config user.email
    ]
    api = MagicMock(); api.get_pr.return_value = {"head": {"ref": "feature/actual"}}
    mock_get_api.return_value = api
    result = tool_commit_and_push(
        {"message": "fix", "branch": "feature/wrong", "pr_number": 1},
        {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}}
    )
    assert result["ok"] == False
    assert result["error"]["code"] == "BRANCH_MISMATCH"


@patch('tools.code.run_git')
def test_commit_and_push_identity_missing(mock_git):
    mock_git.return_value = (1, "", "")  # git config user.name 返回空
    result = tool_commit_and_push(
        {"message": "fix", "branch": "feature/x"},
        {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}}
    )
    assert result["ok"] == False
    assert result["error"]["code"] == "GIT_IDENTITY_MISSING"


# ===== merge_pr =====

@patch('tools.code.get_review_summary')
@patch('tools.code.get_api')
def test_merge_pr_dry_run(mock_get_api, mock_summary):
    api = MagicMock(); api.get_pr.return_value = {"head": {"sha": "abc"}, "base": {"ref": "main"}, "mergeable": True, "mergeable_state": "clean"}
    mock_get_api.return_value = api
    mock_summary.return_value = {"overall": "complete", "phases": [], "next": {}}
    result = tool_merge_pr(
        {"pr_number": 1, "dry_run": True},
        {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}, "platform": "github"}
    )
    assert result["ok"] == True
    assert result["data"]["merged"] == False
    assert result["data"]["mergeable"] == True
    assert result["data"]["review_status"] == "complete"


@patch('tools.code.get_review_summary')
@patch('tools.code.get_api')
def test_merge_pr_not_allowed_review_incomplete(mock_get_api, mock_summary):
    api = MagicMock(); api.get_pr.return_value = {"head": {"sha": "abc"}, "base": {"ref": "main"}}
    mock_get_api.return_value = api
    mock_summary.return_value = {"overall": "in_progress", "phases": [], "next": {}}
    result = tool_merge_pr(
        {"pr_number": 1},
        {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}, "platform": "github"}
    )
    assert result["ok"] == False
    assert result["error"]["code"] == "MERGE_NOT_ALLOWED"
    assert "in_progress" in result["error"]["message"]


@patch('tools.code.get_review_summary')
@patch('tools.code.get_api')
def test_merge_pr_success(mock_get_api, mock_summary):
    api = MagicMock()
    api.get_pr.return_value = {"head": {"sha": "abc"}, "base": {"ref": "main"}}
    api.merge_pr.return_value = {"merged": True, "message": "Pull Request successfully merged", "sha": "mergeSHA"}
    mock_get_api.return_value = api
    mock_summary.return_value = {"overall": "complete", "phases": [], "next": {}}
    result = tool_merge_pr(
        {"pr_number": 1, "merge_method": "squash"},
        {"github": {"token": "t", "repo_owner": "o", "repo_name": "r"}, "platform": "github"}
    )
    assert result["ok"] == True
    assert result["data"]["merged"] == True
    assert result["data"]["sha"] == "mergeSHA"
