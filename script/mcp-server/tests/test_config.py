# tests/test_config.py
from unittest.mock import patch
from config import detect_github_token, detect_repo_info, load_config

@patch('subprocess.run')
def test_detect_repo_info_https(mock_run):
    mock_run.return_value.stdout = "https://github.com/wang/hsoft.git\n"
    mock_run.return_value.returncode = 0
    owner, repo = detect_repo_info()
    assert owner == "wang"; assert repo == "hsoft"

@patch('subprocess.run')
def test_detect_repo_info_ssh(mock_run):
    mock_run.return_value.stdout = "git@github.com:alice/hsoft-data-manage.git\n"
    mock_run.return_value.returncode = 0
    owner, repo = detect_repo_info()
    assert owner == "alice"; assert repo == "hsoft-data-manage"
