# pr-forge v3.0 → v3.1 修改方案

## 一、Codex 配置格式修复 🔴

**现状：** `init.js` 中 `generateCodexMcpJson()` 写入 `~/.codex/.mcp.json`（JSON 格式）。Codex 实际读取 `~/.codex/config.toml`，当前文件不会被加载。

**修改：**

1. 删除 `generateCodexMcpJson()`
2. 新增 `generateCodexToml()`，写入 `~/.codex/config.toml`
3. 已有 `config.toml` → 检查是否已存在 `[mcp_servers.pr-forge]`，有则跳过，无则末尾追加
4. TOML 模板根据凭据类型区分：

```toml
# PAT 模式
[mcp_servers.pr-forge]
command = 'pr-forge'
args = []
startup_timeout_sec = 120

[mcp_servers.pr-forge.env]
PR_FORGE_TOKEN = "gho_xxx"
GITHUB_REPOSITORY = "owner/repo"

# GitHub App 模式
[mcp_servers.pr-forge]
command = 'pr-forge'
args = []
startup_timeout_sec = 120

[mcp_servers.pr-forge.env]
PR_FORGE_GITHUB_APP_ID = "123456"
PR_FORGE_GITHUB_APP_PRIVATE_KEY = '''
-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----
'''
PR_FORGE_GITHUB_APP_INSTALLATION_ID = "98765432"
```

---

## 二、`init` 合并 `auth` — 一个命令解决所有事 🔴

**现状：** 用户需要先 `init`（生成 config.json）再 `auth`（创建 GitHub App），两个命令分开。

**修改：**

`pr-forge init` 成为唯一入口：

```
pr-forge init
  → 检测 git remote
    → github.com → 直接走 Manifest Flow（不言 PAT，PAT 调不了 Check Runs）
    → gitee.com → 交互式问 token
    → 检测不到 → "请在 GitHub/Gitee 仓库根目录运行"
  → 自动检测所有项目类型 → 生成 config.json
  → 生成 .claude/mcp.json
  → 生成 ~/.codex/config.toml（新格式）
  → 加 .gitignore
```

`auth` 命令保留，仅用于 PAT → App 升级场景。

---

## 三、多项目类型自动检测 🔴

**现状：** `detectProjectType()` 只返回第一个匹配。多语言项目（如 Java + React）丢失前端 phase。

**修改：**

1. `detectProjectType()` → 改为 `detectAllProjectTypes()`，返回所有匹配项
2. 每个检测到的类型对应一个 phase：

```json
{
  "phases": [
    { "id": "java-verify", "name": "Java 验证", "check": "mvn compile -q && mvn test" },
    { "id": "js-verify", "name": "前端验证", "check": "cd frontend && npm run lint && npm test" }
  ]
}
```

3. 生成后提示用户可追加未检测到的类型：

```
  ✓ 已检测到 2 种项目类型

  → 是否增加其他项目类型？[y/N]
    y → 列出未检测到的（Rust/Go/Python/自定义），勾选追加
    n → 直接生成
```

---

## 四、`merge_pr` SHA 过期自动重验证 🟠

**现状：** SHA 不一致 → 返回 `REVIEW_STALE` → Agent 手动重跑。

**修改：** `merge_pr` 发现 SHA 过期后：

```
1. 自动调 run_pr_checks（跑新 commit）
2. 全部 phase 通过 → 直接合并
3. 有 phase 挂了 → 拒绝，返回具体失败 phase
4. 旧结论 neutral → 返回 neutral，等 acknowledge
```

Agent 无感知，用户无操作。

---

## 五、改动文件清单

| 文件 | 改动 |
|------|------|
| `src/init.js` | 改 `generateCodexMcpJson` → `generateCodexToml`；改 `detectProjectType` → `detectAllProjectTypes`；追加项目类型交互 |
| `src/cli-init.js` | 合并 Manifest Flow；检测 GitHub → 自动走 App 创建 |
| `src/cli-auth.js` | 保留但标注为"升级场景专用" |
| `src/tools/conclusion.js` | `merge_pr` 增加 SHA 过期自动重验证逻辑 |

---

## 六、不改动的

- 9 个 MCP 工具签名不变
- GitHub/Gitee 平台适配不变
- 安全模型（config hash、token 存储、并发锁）不变
- 24 个错误码不变
- v2 兼容路径不变
