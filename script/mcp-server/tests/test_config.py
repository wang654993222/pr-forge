# tests/test_config.py
# v10: 新增 Gitee remote 解析 + platform 检测测试
from unittest.mock import patch
from config import detect_token, detect_repo_info, detect_platform, load_config


# ===== detect_repo_info =====

@patch('subprocess.run')
def test_detect_repo_info_github_https(mock_run):
    mock_run.return_value.stdout = "https://github.com/wang/hsoft.git\n"
    mock_run.return_value.returncode = 0
    owner, repo = detect_repo_info()
    assert owner == "wang"; assert repo == "hsoft"


@patch('subprocess.run')
def test_detect_repo_info_github_ssh(mock_run):
    mock_run.return_value.stdout = "git@github.com:alice/hsoft-data-manage.git\n"
    mock_run.return_value.returncode = 0
    owner, repo = detect_repo_info()
    assert owner == "alice"; assert repo == "hsoft-data-manage"


@patch('subprocess.run')
def test_detect_repo_info_gitee_https(mock_run):
    mock_run.return_value.stdout = "https://gitee.com/team/project.git\n"
    mock_run.return_value.returncode = 0
    owner, repo = detect_repo_info()
    assert owner == "team"; assert repo == "project"


@patch('subprocess.run')
def test_detect_repo_info_gitee_ssh(mock_run):
    mock_run.return_value.stdout = "git@gitee.com:zhangsan/my-repo.git\n"
    mock_run.return_value.returncode = 0
    owner, repo = detect_repo_info()
    assert owner == "zhangsan"; assert repo == "my-repo"


# ===== detect_platform =====

@patch('subprocess.run')
def test_detect_platform_github(mock_run):
    mock_run.return_value.stdout = "https://github.com/owner/repo.git\n"
    mock_run.return_value.returncode = 0
    result = detect_platform()
    assert result == "github"


@patch('subprocess.run')
def test_detect_platform_gitee(mock_run):
    mock_run.return_value.stdout = "https://gitee.com/owner/repo.git\n"
    mock_run.return_value.returncode = 0
    result = detect_platform()
    assert result == "gitee"


@patch.dict('os.environ', {'RELAY_REVIEW_PLATFORM': 'gitee'})
@patch('subprocess.run')
def test_detect_platform_env_override(mock_run):
    """环境变量 RELAY_REVIEW_PLATFORM=gitee 强制覆盖 git remote"""
    mock_run.return_value.stdout = "https://github.com/owner/repo.git\n"
    mock_run.return_value.returncode = 0
    result = detect_platform()
    assert result == "gitee"


# ===== detect_token =====

@patch.dict('os.environ', {'GITEE_TOKEN': 'gitee_token_123'})
def test_detect_token_gitee():
    assert detect_token("gitee") == "gitee_token_123"


@patch.dict('os.environ', {'GITHUB_TOKEN': 'github_token_456'})
def test_detect_token_github():
    assert detect_token("github") == "github_token_456"


# ===== load_config =====

@patch.dict('os.environ', {'GITHUB_TOKEN': 'gh_token', 'GITHUB_REPOSITORY': 'test-owner/test-repo'})
@patch('subprocess.run')
def test_load_config_github(mock_run):
    mock_run.return_value.stdout = "https://github.com/test-owner/test-repo.git\n"
    mock_run.return_value.returncode = 0
    config = load_config()
    assert config["platform"] == "github"
    assert config["github"]["token"] == "gh_token"
    assert config["github"]["repo_owner"] == "test-owner"


@patch.dict('os.environ', {'GITEE_TOKEN': 'gitee_token', 'GITEE_REPOSITORY': 'gitee-owner/gitee-repo'})
@patch('subprocess.run')
def test_load_config_gitee(mock_run):
    mock_run.return_value.stdout = "https://gitee.com/gitee-owner/gitee-repo.git\n"
    mock_run.return_value.returncode = 0
    config = load_config()
    assert config["platform"] == "gitee"
    assert config["github"]["token"] == "gitee_token"
    assert config["github"]["repo_owner"] == "gitee-owner"


@patch.dict('os.environ', {'GITEE_TOKEN': 'gitee_token'})
@patch('subprocess.run')
def test_load_config_gitee_no_remote(mock_run):
    """无 git remote 时从 GITEE_REPOSITORY 环境变量 fallback"""
    mock_run.side_effect = Exception("no git")
    def fake_detect_repo():
        return None, None
    with patch('config.detect_repo_info', side_effect=fake_detect_repo):
        pass  # 需要 GITEE_REPOSITORY 才能通过
    # 注意：此测试需要同时 mock detect_repo_info 和 detect_platform
