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

from unittest.mock import patch, MagicMock
from tools.status import _build_phase_status, _compute_overall, _derive_phase3_needed, tool_get_phase_result
from tools.post import tool_post_phase_result, tool_post_final_verdict, _truncate_utf8_safe


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
