# pr-flow Skill

接力审查系统 — 通过 GitHub/Gitee PR Comment 实现 Claude ↔ Codex 跨机器代码互审，
支持审查 → 修复 → 推送 → 再审查 → 合并 完整闭环。

## 触发

"审查 PR #N" / "review PR #N" / "对 PR #N 做接力审查"

## 操作指令

### Phase 1: 代码审查

1. `get_pr_context(N)` — 验证 PR OPEN + 非 draft，记录 `head_sha`, `head_ref`
2. `get_pr_diff(N)` — 获取 PR unified diff 了解代码变更
3. `get_review_status(N)` — 检查 `next.phase == 1` + `next.ready == true`
   - 如果 `ready == false` + `reason == "phase_expired"`: 提示用户用 --force 重跑 Phase 1
4. Bash: `./review-pr.sh N --phase=1` — 执行审查 (内部 claude --bare -p)
5. `post_phase_result(N, phase=1, body=<result>, sha=<from_step_1>)` — 发布结果
   - 网络断开 → `post_phase_result(N, phase=1, from_local_file=true)`

### Fix: 修复问题 (v11 新增)

当 Phase 1 审查发现代码问题时:

1. `get_file_content(path, ref=head_ref)` — 读取需要修改的文件
2. 编辑文件修复问题 (Write/Edit 工具)
3. `commit_and_push(message="fix: ...", branch=head_ref, pr_number=N)` — 提交并推送到 PR 分支
   - 建议先 `dry_run=true` 预览要提交的文件
   - 传 `files=["path1", "path2"]` 精确控制提交范围
   - 推送后新 SHA 会使 Phase 1 审查结果自动过期

### Re-Review: 再审查 (v11 新增)

1. `get_review_status(N)` — Phase 1 变为 "expired" (SHA 不匹配)
   - `overall: "blocked"`, `next.ready: false`, `reason: "phase_expired"`
2. 重新执行 Phase 1 审查确认修复正确
3. `post_phase_result(N, phase=1, body=<re-review>, sha=<new_sha>)`

### Phase 2: 接力复核

1. `get_review_status(N)` — 检查 Phase 1 状态
   - `next.reason == "phase_pending"` → 启动轮询等待 (见下方轮询策略)
2. `get_phase_result(N, phase=1)` — 获取 Phase 1 审查结果
   - `reason == "sha_mismatch"` → Phase 1 结果过期，提示用户重跑 Phase 1
3. Bash: `./review-pr.sh N --phase=2` — 执行复核 (内部 codex exec)
4. `post_phase_result(N, phase=2, body=<result>, sha=<current_sha>)`

### Phase 3: DB 验证

1. `get_review_status(N)` — 检查 `phase3_needed`
2. Bash: `./review-pr.sh N --phase=3` — DB 验证 (内部 claude -p + any-db MCP)
3. `post_phase_result(N, phase=3, body=<result>, sha=<current_sha>)`

### Final: 合并 (v11 增强)

1. `get_review_status(N)` — 确认所有 Phase 完成，`overall == "complete"`
2. `post_final_verdict(N, verdict=<auto>, summary=<generated>)` — 发布最终 Review
3. `merge_pr(N, merge_method="squash", dry_run=true)` — 检查可合并性
   - 审查完成预检未通过 → 返回 `MERGE_NOT_ALLOWED`，修复后重试
4. **🛑 展示 dry_run 结果和最终审查结论，等待用户确认合并（禁止自动合并）**
5. 用户明确确认后: `merge_pr(N, merge_method="squash")` — 执行合并

## 完整工作流 (v11)

```
Phase 1 审查 → 发现问题 → 修复代码 → commit_and_push → SHA 过期
    → 再审查(Phase 1) → 通过 → Phase 2 → Phase 3 → merge_pr
```

## 9 个 MCP Tool 参考

| # | Tool | 参数 | 版本 | 功能 |
|---|------|------|:---:|------|
| 1 | `get_pr_context` | `pr_number` | v10 | 拉取 PR 元数据 (title/state/draft/SHA/branch/author) |
| 2 | `get_review_status` | `pr_number` | v10 | 构建 Phase 1/2/3 审查状态矩阵 + next action |
| 3 | `get_phase_result` | `pr_number`, `phase` | v10 | 精确提取 Phase N 的审查结果 (SHA 匹配) |
| 4 | `post_phase_result` | `pr_number`, `phase`, `body`, `sha`, `dry_run?`, `from_local_file?` | v10 | 发布审查结果到 PR Comment (65K 截断) |
| 5 | `post_final_verdict` | `pr_number`, `verdict`, `summary` | v10 | 发布最终 PR Review (approve/request_changes/comment) |
| 6 | `get_pr_diff` | `pr_number`, `max_bytes?` | v11 | 获取 PR unified diff |
| 7 | `get_file_content` | `path`, `ref?` | v11 | 获取仓库文件内容 (支持二进制检测) |
| 8 | `commit_and_push` | `message`, `branch`, `pr_number?`, `files?`, `dry_run?` | v11 | 提交修复并推送到 PR 分支 |
| 9 | `merge_pr` | `pr_number`, `merge_method?`, `delete_branch?`, `dry_run?` | v11 | 合并 PR 到主分支 (内置审查完成预检) |

## 错误恢复

| 错误场景 | 操作 |
|---------|------|
| PR diff 缓存过期 | `review-pr.sh N --phase=1 --force` |
| Phase 1 SHA 不匹配 | 提示用户 PR 被 rebase，需重跑 Phase 1 |
| `post_phase_result` 网络失败 | 用 `from_local_file=true` 重试 |
| Phase 3 不需要 DB 验证 | 跳过 Phase 3，直接 Final |
| Phase 1 重复执行防护 | PR comment 已有同 SHA 结果 → skip |
| `commit_and_push` branch 不匹配 | 检查 `pr_number` 参数 → 自动校验 `head_ref` |
| `commit_and_push` 无 git identity | 配置 `git config user.name` / `user.email` |
| `merge_pr` 审查未完成 | 继续完成剩余 Phase 后重试 |

## 轮询等待策略

当 `get_review_status` 返回 `next.ready == false` + `next.reason == "phase_pending"` 时:

```
interval = 30  # 秒
max_checks = 60  # 30 分钟上限
backoff = 1.0  # 指数退避乘数 (每次翻倍, 上限 300s)

for check in 1..max_checks:
    sleep(interval * backoff)
    status = get_review_status(N)
    if status.next.ready: break  # 前置完成
    if status.next.reason == "phase_expired": 报错退出  # PR rebase

    # 403/429 → backoff *= 2 (max 300s)
    # 401/404 → 报错退出 (永久性错误)

if check >= max_checks: 超时报错
```
