# pr-flow v3.0 实施计划

## 项目概况
将 Python v2 重写为 Node.js v3.0 MCP 服务，零 npm 依赖，共 9 个 MCP 工具，支持 GitHub + Gitee 双平台。

## 任务列表

### Batch 1: 基础设施
- [ ] **T1** — 创建 package.json、项目入口、错误码模块
- [ ] **T2** — 实现 config 管理（load/hash/verify/.approved）
- [ ] **T3** — 实现文件锁模块（排他创建、PID检测、死锁恢复）

### Batch 2: 平台层
- [ ] **T4** — 实现 GitHub 平台适配器（API + Check Runs）
- [ ] **T5** — 实现 Gitee 平台适配器（API + Commit Status）
- [ ] **T6** — 实现平台路由器（auto-detect）

### Batch 3: MCP 工具组 A（只读工具）
- [ ] **T7** — 实现 get_pr_context
- [ ] **T8** — 实现 get_pr_diff + get_file_content
- [ ] **T9** — 实现 get_review_plan + get_review_status

### Batch 4: MCP 工具组 B（写操作工具）
- [ ] **T10** — 实现 commit_and_push
- [ ] **T11** — 实现 run_pr_checks（含 config hash 校验、git 操作、phase 执行）
- [ ] **T12** — 实现 set_conclusion + merge_pr

### Batch 5: CLI + 集成
- [ ] **T13** — 实现 pr-flow init（项目检测、config 生成、token 管理）
- [ ] **T14** — 实现 pr-flow doctor（环境诊断）
- [ ] **T15** — 实现 server.js（MCP 双模式入口）+ CLI 入口

### Batch 6: 收尾
- [ ] **T16** — 代码审查 + 清理测试代码 + 最终验证
