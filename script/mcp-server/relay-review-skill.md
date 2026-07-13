# Relay Review Skill

接力审查系统 — 通过 GitHub PR Comment 实现 Claude ↔ Codex 跨机器代码互审。

## 触发

"审查 PR #N" / "review PR #N" / "对 PR #N 做接力审查"

## 操作指令

### Phase 1: 代码审查

1. `get_pr_context(N)` — 验证 PR OPEN + 非 draft
2. `get_review_status(N)` — 检查 `next.phase == 1` + `next.ready == true`
   - 如果 `ready == false` + `reason == "phase_expired"`: 提示用户用 --force 重跑 Phase 1
3. Bash: `./review-pr.sh N --phase=1` — 执行审查 (内部 claude --bare -p)
4. `post_phase_result(N, phase=1, body=<result>, sha=<from_step_1>)` — 发布结果
   - 网络断开 → `post_phase_result(N, phase=1, from_local_file=true)`

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

### Final: 最终判定

1. `get_review_status(N)` — 确认所有 Phase 完成
2. `post_final_verdict(N, verdict=<auto>, summary=<generated>)`

## 错误恢复

| 错误场景 | 操作 |
|---------|------|
| PR diff 缓存过期 | `review-pr.sh N --phase=1 --force` |
| Phase 1 SHA 不匹配 | 提示用户 PR 被 rebase，需 --force 重跑 Phase 1 |
| `post_phase_result` 网络失败 | 用 `from_local_file=true` 重试 |
| Phase 3 不需要 DB 验证 | 跳过 Phase 3，直接 Final |
| Phase 1 重复执行防护 | PR comment 已有同 SHA 结果 → skip |

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
