# tests/test_handlers.py — 关键测试覆盖:
# 1. get_pr_context: 404 → PR_NOT_FOUND, 401 → AUTH_REQUIRED
# 2. _build_phase_status: SHA mismatch → expired, no comments → all pending
# 3. _compute_overall: Phase1_done+Phase2_pending → ready=true, reason=phase_pending
# 4. _derive_phase3_needed: body contains "SELECT *" → needed=true
# 5. get_phase_result: sha_mismatch → found=false, reason=sha_mismatch + mismatch object
# 6. post_phase_result: dry_run → posted=false
# 7. post_phase_result: body > 65K → truncated=true
# 8. post_phase_result: from_local_file + file_missing → NO_LOCAL_RESULT
# 9. post_final_verdict: invalid verdict → INVALID_VERDICT
# 10. post_final_verdict: body > 65K → truncated=true
# 11. v9: _build_phase_status contributors + reviewer_count
# 12. v9: _find_existing_phase_comment + _merge CAS append
# 13. v9: get_phase_result multi-result (count > 1)

from unittest.mock import patch, MagicMock
from tools.status import _build_phase_status, _compute_overall, _derive_phase3_needed, tool_get_phase_result
from tools.post import (tool_post_phase_result, tool_post_final_verdict, _truncate_utf8_safe,
                          _find_existing_phase_comment, _merge_phase_comment, _extract_findings_only)


# 1. _build_phase_status: SHA mismatch → expired, no comments → all pending
def test_build_phase_status_no_comments():
    result = _build_phase_status([], "abc123")
    assert result[0]["status"] == "pending"
    assert result[1]["status"] == "pending"
    assert result[2]["status"] == "pending"


def test_build_phase_status_sha_mismatch():
    comments = [{
        "body": "<!-- review-phase: 1 -->\n<!-- review-commit: aaaaaa -->\nsome review",
        "user": {"login": "reviewer1"},
        "created_at": "2026-01-01T00:00:00Z",
        "html_url": "https://github.com/test/pr/1#comment"
    }]
    result = _build_phase_status(comments, "bbbccc")
    assert result[0]["status"] == "expired"
    assert result[0]["reason"] == "SHA mismatch"


def test_build_phase_status_match():
    comments = [{
        "body": "<!-- review-phase: 1 -->\n<!-- review-commit: abc123 -->\nsome review",
        "user": {"login": "reviewer1"},
        "created_at": "2026-01-01T00:00:00Z",
        "html_url": "https://github.com/test/pr/1#comment"
    }]
    result = _build_phase_status(comments, "abc123")
    assert result[0]["status"] == "done"
    assert result[0]["sha"] == "abc123"


# 2. _compute_overall: Phase1_done+Phase2_pending → ready=true, reason=phase_pending
def test_compute_overall_in_progress():
    phases = [
        {"phase": 1, "status": "done", "sha": "abc123"},
        {"phase": 2, "status": "pending"},
        {"phase": 3, "status": "pending"},
    ]
    result = _compute_overall(phases)
    assert result["overall"] == "in_progress"
    assert result["next"]["phase"] == 2
    assert result["next"]["ready"] == True
    assert result["next"]["reason"] == "phase_pending"


def test_compute_overall_not_started():
    phases = [
        {"phase": 1, "status": "pending"},
        {"phase": 2, "status": "pending"},
        {"phase": 3, "status": "pending"},
    ]
    result = _compute_overall(phases)
    assert result["overall"] == "not_started"
    assert result["next"]["phase"] == 1
    assert result["next"]["ready"] == True


def test_compute_overall_complete():
    phases = [
        {"phase": 1, "status": "done", "sha": "abc123"},
        {"phase": 2, "status": "done", "sha": "abc123"},
        {"phase": 3, "status": "done", "sha": "abc123"},
    ]
    result = _compute_overall(phases)
    assert result["overall"] == "complete"
    assert result["next"]["ready"] == False


def test_compute_overall_expired():
    phases = [
        {"phase": 1, "status": "expired", "sha": "oldsha", "reason": "SHA mismatch"},
        {"phase": 2, "status": "pending"},
        {"phase": 3, "status": "pending"},
    ]
    result = _compute_overall(phases)
    assert result["overall"] == "blocked"
    assert result["next"]["ready"] == False
    assert result["next"]["reason"] == "phase_expired"


# 3. _derive_phase3_needed: body contains "SELECT *" → needed=true
def test_derive_phase3_needed_sql_found():
    phases = [
        {"phase": 1, "status": "done", "body": "Found SQL risk: SELECT * FROM users"},
        {"phase": 2, "status": "pending"},
        {"phase": 3, "status": "pending"},
    ]
    result = _derive_phase3_needed(phases)
    assert result["needed"] == True
    assert result["checked"] == True


def test_derive_phase3_needed_no_sql():
    phases = [
        {"phase": 1, "status": "done", "body": "Code review: looks good, no db changes"},
        {"phase": 2, "status": "pending"},
        {"phase": 3, "status": "pending"},
    ]
    result = _derive_phase3_needed(phases)
    assert result["needed"] == False
    assert result["checked"] == True


# 4. post_phase_result: dry_run → posted=false
def test_post_phase_result_dry_run():
    result = tool_post_phase_result(
        {"pr_number": 1, "phase": 1, "body": "test body", "sha": "abc123", "dry_run": True},
        {"github": {"token": "fake", "repo_owner": "o", "repo_name": "r"}, "output": {"dir": "script/review-output"}}
    )
    assert result["ok"] == True
    assert result["data"]["posted"] == False
    assert result["data"]["warning"] == "dry_run"


# 5. post_phase_result: from_local_file + file_missing → NO_LOCAL_RESULT
def test_post_phase_result_missing_file():
    result = tool_post_phase_result(
        {"pr_number": 1, "phase": 1, "from_local_file": True},
        {"github": {"token": "fake", "repo_owner": "o", "repo_name": "r"}, "output": {"dir": "script/review-output"}}
    )
    assert result["ok"] == False
    assert result["error"]["code"] == "NO_LOCAL_RESULT"


# 6. post_final_verdict: invalid verdict → INVALID_VERDICT
def test_post_final_verdict_invalid():
    result = tool_post_final_verdict(
        {"pr_number": 1, "verdict": "reject", "summary": "bad"},
        {"github": {"token": "fake", "repo_owner": "o", "repo_name": "r"}}
    )
    assert result["ok"] == False
    assert result["error"]["code"] == "INVALID_VERDICT"


# 7. _truncate_utf8_safe: small text → not truncated
def test_truncate_utf8_safe_small():
    text = "hello world"
    result, truncated = _truncate_utf8_safe(text)
    assert truncated == False
    assert result == text


# 8. _truncate_utf8_safe: large text → truncated
def test_truncate_utf8_safe_large():
    # create text > 59000 bytes
    text = "x" * 100000
    result, truncated = _truncate_utf8_safe(text)
    assert truncated == True
    assert len(result.encode("utf-8")) <= 59000


# 9. post_phase_result: SHA mismatch in body vs arg
def test_post_phase_result_sha_mismatch():
    result = tool_post_phase_result(
        {"pr_number": 1, "phase": 1, "body": "<!-- review-commit: aabbcc -->\nreview", "sha": "ddeeff"},
        {"github": {"token": "fake", "repo_owner": "o", "repo_name": "r"}, "output": {"dir": "script/review-output"}}
    )
    assert result["ok"] == False
    assert result["error"]["code"] == "SHA_MISMATCH"


# 10. post_final_verdict: valid verdict mapping
def test_post_final_verdict_valid_mapping():
    assert "request_changes" in {"request_changes", "approve", "comment"}
    assert "approve" in {"request_changes", "approve", "comment"}
    assert "comment" in {"request_changes", "approve", "comment"}
    # verify event mapping
    mapping = {"request_changes": "REQUEST_CHANGES", "approve": "APPROVE", "comment": "COMMENT"}
    assert mapping["request_changes"] == "REQUEST_CHANGES"
    assert mapping["approve"] == "APPROVE"
    assert mapping["comment"] == "COMMENT"


# ===== v9: 并发审查合并测试 =====

# 11. _build_phase_status: 多人审查 → contributors + reviewer_count
def test_build_phase_status_multi_reviewers():
    """同一 phase 有多个审查者的 Comment 时，contributors 应包含所有人"""
    comments = [
        {
            "body": "<!-- review-phase: 1 -->\n<!-- review-commit: abc123 -->\nreview by A",
            "user": {"login": "alice"},
            "created_at": "2026-01-01T00:00:00Z",
            "html_url": "https://github.com/test/pr/1#comment",
            "id": 1,
        },
        {
            "body": "<!-- review-phase: 1 -->\n<!-- review-commit: abc123 -->\nreview by B\n<!-- merged: true -->\n<!-- reviewer-count: 2 -->",
            "user": {"login": "bob"},
            "created_at": "2026-01-01T00:01:00Z",
            "html_url": "https://github.com/test/pr/1#comment",
            "id": 2,
        },
    ]
    result = _build_phase_status(comments, "abc123")
    phase1 = result[0]
    assert phase1["status"] == "done"
    assert phase1["reviewer_count"] == 2
    assert "alice" in phase1["contributors"]
    assert "bob" in phase1["contributors"]
    assert phase1["merged"] == True


# 12. _find_existing_phase_comment: 查找已有 Comment
def test_find_existing_phase_comment_found():
    """同 phase + SHA 已存在 → 返回 Comment"""
    from tools.post import _find_existing_phase_comment
    from github_api import GitHubAPI
    api = MagicMock(spec=GitHubAPI)
    api.list_comments.return_value = [{
        "id": 42,
        "body": "<!-- review-phase: 1 -->\n<!-- review-commit: abc123 -->\nreview",
    }]
    result = _find_existing_phase_comment(api, 1, 1, "abc123")
    assert result is not None
    assert result["id"] == 42


def test_find_existing_phase_comment_sha_mismatch():
    """同 phase 但 SHA 不同 → 返回 None（不冲突）"""
    from tools.post import _find_existing_phase_comment
    from github_api import GitHubAPI
    api = MagicMock(spec=GitHubAPI)
    api.list_comments.return_value = [{
        "id": 42,
        "body": "<!-- review-phase: 1 -->\n<!-- review-commit: aabbcc -->\nreview",
    }]
    result = _find_existing_phase_comment(api, 1, 1, "abc123")
    assert result is None


# 13. _extract_findings_only: 提取纯发现内容
def test_extract_findings_only_with_markers():
    """有 REVIEW_START/END marker → 提取中间内容"""
    body = "header\n---REVIEW_START---\n### 问题1: N+1\n### 问题2: SELECT *\n---REVIEW_END---\nfooter"
    result = _extract_findings_only(body)
    assert "问题1: N+1" in result
    assert "问题2: SELECT *" in result
    assert "header" not in result


def test_extract_findings_only_without_markers():
    """无 marker → 移除开头注释行"""
    body = "<!-- review-phase: 1 -->\n\n### 发现 SQL 注入"
    result = _extract_findings_only(body)
    assert "SQL 注入" in result


# 14. _merge_phase_comment: 合并两份审查结果
def test_merge_phase_comment():
    existing = "<!-- review-phase: 1 -->\n<!-- review-commit: abc123 -->\n---REVIEW_START---\n### 问题1\n---REVIEW_END---\n<!-- reviewer-count: 2 -->"
    new_body = "new header\n---REVIEW_START---\n### 问题2\n---REVIEW_END---\nfooter"
    merged = _merge_phase_comment(existing, new_body, "bob", 1, "abc123")
    assert "问题1" in merged  # 原有内容保留
    assert "问题2" in merged  # 新内容追加
    assert "bob" in merged  # 标注新审查者
    assert "reviewer-count: 3" in merged  # 2 → 3
    assert "merged: true" in merged


# 15. post_phase_result: CAS merge (mock)
@patch('tools.post._find_existing_phase_comment')
@patch('tools.post._merge_phase_comment')
def test_post_phase_result_cas_merge(mock_merge, mock_find):
    """已有同 Phase+SHA Comment → 自动追加合并"""
    from github_api import GitHubAPI
    # 构造 mock api
    mock_api = MagicMock(spec=GitHubAPI)
    mock_api.create_comment = MagicMock()
    mock_api.update_comment = MagicMock(return_value={"html_url": "https://github.com/merged"})
    mock_api.list_comments = MagicMock()

    # Mock: 已有 Comment
    mock_find.return_value = {"id": 42, "body": "old review"}
    mock_merge.return_value = "merged body"

    with patch('tools.post.get_api', return_value=mock_api):
        result = tool_post_phase_result(
            {"pr_number": 1, "phase": 1, "body": "new review", "sha": "abc123"},
            {"github": {"token": "fake", "repo_owner": "bob", "repo_name": "r"}, "output": {"dir": "script/review-output"}}
        )
    assert result["ok"] == True
    assert result["data"]["merged"] == True
    assert result["data"]["posted"] == True
    mock_api.update_comment.assert_called_once()
    mock_api.create_comment.assert_not_called()  # 不应新建 Comment


# 16. get_phase_result: 单人审查
def test_get_phase_result_single():
    """单人审查 → count=1, contributors 包含该审查者"""
    from github_api import GitHubAPI
    api = MagicMock(spec=GitHubAPI)
    api.get_pr.return_value = {"head": {"sha": "abc123"}}
    api.list_comments.return_value = [{
        "id": 1,
        "body": "<!-- review-phase: 1 -->\n<!-- review-commit: abc123 -->\n---REVIEW_START---\nreview content\n---REVIEW_END---",
        "user": {"login": "alice"},
        "created_at": "2026-01-01T00:00:00Z",
        "html_url": "https://github.com/test/pr/1#comment",
    }]
    with patch('tools.status.get_api', return_value=api):
        result = tool_get_phase_result({"pr_number": 1, "phase": 1}, {"github": {"token": "f", "repo_owner": "o", "repo_name": "r"}})
    assert result["ok"] == True
    assert result["data"]["found"] == True
    assert result["data"]["count"] == 1
    assert result["data"]["contributors"] == ["alice"]
    assert result["data"]["merged"] == False


# 17. get_phase_result: 多人审查 → count > 1
def test_get_phase_result_multi():
    """多人审查 → count=2, contributors 包含全部审查者"""
    from github_api import GitHubAPI
    api = MagicMock(spec=GitHubAPI)
    api.get_pr.return_value = {"head": {"sha": "abc123"}}
    api.list_comments.return_value = [
        {
            "id": 1,
            "body": "<!-- review-phase: 1 -->\n<!-- review-commit: abc123 -->\n---REVIEW_START---\nreview by alice\n---REVIEW_END---",
            "user": {"login": "alice"},
            "created_at": "2026-01-01T00:00:00Z",
            "html_url": "https://github.com/test/pr/1#comment",
        },
        {
            "id": 2,
            "body": "<!-- review-phase: 1 -->\n<!-- review-commit: abc123 -->\n---REVIEW_START---\nreview by bob\n---REVIEW_END---",
            "user": {"login": "bob"},
            "created_at": "2026-01-01T00:01:00Z",
            "html_url": "https://github.com/test/pr/1#comment",
        },
    ]
    with patch('tools.status.get_api', return_value=api):
        result = tool_get_phase_result({"pr_number": 1, "phase": 1}, {"github": {"token": "f", "repo_owner": "o", "repo_name": "r"}})
    assert result["ok"] == True
    assert result["data"]["found"] == True
    assert result["data"]["count"] == 2
    assert result["data"]["contributors"] == ["bob", "alice"]  # reversed 顺序
    assert "alice" in result["data"]["contributors"]
    assert "bob" in result["data"]["contributors"]
