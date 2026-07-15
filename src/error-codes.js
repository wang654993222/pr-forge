const ErrorCode = {
  AUTH_REQUIRED: {
    code: 'AUTH_REQUIRED',
    message: 'Token 无效或未配置',
    recovery: '运行 pr-forge init 重新配置 token，或检查环境变量 PR_FLOW_TOKEN',
  },
  PR_NOT_FOUND: {
    code: 'PR_NOT_FOUND',
    message: 'PR 不存在',
    recovery: '确认 PR 编号正确，确认仓库名和 owner 与当前项目匹配',
  },
  NO_PULL_REQUEST: {
    code: 'NO_PULL_REQUEST',
    message: '没有 open PR',
    recovery: '当前仓库无可审查的 PR，先创建 PR 或使用 pr_number 参数指定已有 PR',
  },
  FILE_NOT_FOUND: {
    code: 'FILE_NOT_FOUND',
    message: '文件不存在',
    recovery: '确认文件路径正确，确认 ref 参数指向的分支或 commit 存在',
  },
  NO_CONFIG: {
    code: 'NO_CONFIG',
    message: '.pr-forge/config.json 不存在',
    recovery: '运行 pr-forge init 初始化项目配置',
  },
  CONFIG_MODIFIED: {
    code: 'CONFIG_MODIFIED',
    message: 'config.json 已被修改（hash 不匹配）',
    recovery: '确认修改内容后重新运行 pr-forge init 以更新 .approved hash',
  },
  NO_CHECK_COMMAND: {
    code: 'NO_CHECK_COMMAND',
    message: 'check 字段为空',
    recovery: '编辑 .pr-forge/config.json，为每个 phase 填写 check 命令',
  },
  NETWORK_ERROR: {
    code: 'NETWORK_ERROR',
    message: 'API 网络错误',
    recovery: '检查网络连接，确认 GitHub/Gitee 服务可用，稍后重试',
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    message: 'API 频率限制',
    recovery: '等待 {retry_after} 秒后重试',
  },
  GIT_ERROR: {
    code: 'GIT_ERROR',
    message: 'git 命令执行失败',
    recovery: '检查工作区状态（git status），确认网络和远程仓库配置正确',
  },
  DIRTY_WORKTREE: {
    code: 'DIRTY_WORKTREE',
    message: '工作区有未提交的修改',
    recovery: '先 git stash 暂存或 git commit 提交当前修改，再重新调用',
  },
  BRANCH_MISMATCH: {
    code: 'BRANCH_MISMATCH',
    message: 'branch 与 PR head_ref 不匹配',
    recovery: '确认分支名正确，或改用 pr_number 参数代替 branch 参数',
  },
  NO_CHANGES: {
    code: 'NO_CHANGES',
    message: '没有需要提交的修改',
    recovery: '确认修改已保存（git status 检查），确认文件路径在参数中已指定',
  },
  GIT_IDENTITY_MISSING: {
    code: 'GIT_IDENTITY_MISSING',
    message: 'git user.name/email 未配置',
    recovery: '运行 git config user.name 和 git config user.email 配置身份信息',
  },
  MERGE_NOT_ALLOWED: {
    code: 'MERGE_NOT_ALLOWED',
    message: '审查未完成，禁止合并',
    recovery: '先调用 run_pr_checks 完成验证，再调用 set_conclusion 完成审查，最后重试合并',
  },
  MERGE_CONFLICT: {
    code: 'MERGE_CONFLICT',
    message: '合并冲突',
    recovery: '运行 git fetch origin pull/{n}/head && git merge FETCH_HEAD 手动解决冲突后再合并',
  },
  SHA_MISMATCH: {
    code: 'SHA_MISMATCH',
    message: 'body SHA 与参数 SHA 不匹配',
    recovery: '确认传入的 SHA 与 PR 当前 head SHA 一致',
  },
  REVIEW_STALE: {
    code: 'REVIEW_STALE',
    message: '审查结果已过时（PR 可能被 force-push）',
    recovery: '重新调用 run_pr_checks 获取最新代码的验证结果，再重新调用 set_conclusion',
  },
  CODE_UPDATED_DURING: {
    code: 'CODE_UPDATED_DURING',
    message: '执行期间代码被更新',
    recovery: '重新调用 run_pr_checks 以获取最新代码的验证结果',
  },
  LOCKED: {
    code: 'LOCKED',
    message: '并发锁被占用，另一个 run_pr_checks 正在执行',
    recovery: '等待当前执行完成（锁文件会在执行结束后自动释放），1-2 分钟后重试。如果确认没有并发执行，可手动删除 .pr-forge/locks/pr-{n}.lock',
  },
  INVALID_VERDICT: {
    code: 'INVALID_VERDICT',
    message: 'verdict 值不合法',
    recovery: 'verdict 只能为 success、failure 或 neutral',
  },
  INVALID_PATH: {
    code: 'INVALID_PATH',
    message: '路径包含非法字符',
    recovery: '使用相对于仓库根目录的合法文件路径，不含 ../ 等目录穿越字符',
  },
  TIMEOUT: {
    code: 'TIMEOUT',
    message: '执行超时',
    recovery: '增加 .pr-forge/config.json 中的 timeout 值，或优化 check 命令的执行效率',
  },
  CHECK_FAILED: {
    code: 'CHECK_FAILED',
    message: '验证不通过（非零退出）',
    recovery: '查看 Check Run 输出中的具体错误信息，修复后重新 push 并重试',
  },
};

function error(code, context) {
  const e = ErrorCode[code];
  const result = { ok: false, error: { code: e.code, message: e.message, recovery: e.recovery } };
  if (context !== undefined && context !== null) {
    result.error.context = context;
  }
  return result;
}

const RETRYABLE = new Set(['NETWORK_ERROR', 'LOCKED', 'TIMEOUT', 'RATE_LIMITED']);

function isRetryable(code) {
  return RETRYABLE.has(ErrorCode[code]?.code);
}

export { ErrorCode, error, isRetryable };
