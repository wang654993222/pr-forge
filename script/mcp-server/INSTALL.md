# Relay Review MCP — 多机安装详细教程

> 最后更新: 2026-07-13

## 概述

Relay Review MCP Server 是一个通过 GitHub PR Comment 实现跨机器代码接力审查的系统。两台电脑（机器 A 和机器 B）通过 GitHub PR Comment 中的 HTML marker 进行接力，所有审查结果持久化在 PR 评论中，互相可见。

## 前置条件

- macOS / Linux / Windows (WSL2)
- Python 3.9+
- Claude Code Desktop (已安装)
- GitHub 账号
- 当前项目已推送到 GitHub: `https://github.com/wang654993222/hsoft-data-manage`

---

## 机器 B 安装步骤

### 步骤 1: 克隆仓库

打开终端，执行：

```bash
# 克隆项目到本地
git clone https://github.com/wang654993222/hsoft-data-manage.git
cd hsoft-data-manage
```

### 步骤 2: 安装 Python 依赖

```bash
# 只需要一个依赖
pip install requests
```

> 或者从 requirements.txt 安装:
> ```bash
> pip install -r script/mcp-server/requirements.txt
> ```

验证安装:

```bash
python3 -c "import requests; print('requests', requests.__version__)"
```

### 步骤 3: 创建 GitHub Personal Access Token

为机器 B 创建一个独立的 Token（已预先创建好）：

**机器 B Token:** `REDACTED`

> 如果你需要自己创建新 Token:
> 1. 浏览器打开 https://github.com/settings/tokens/new
> 2. Note: `relay-review-mcp-machine-b`
> 3. Expiration: No expiration
> 4. 勾选 `repo`
> 5. 点击 Generate token，复制生成的 `ghp_xxx...`

### 步骤 4: 创建 `.claude/mcp.json`

在项目根目录 (`hsoft-data-manage/.claude/`) 创建 `mcp.json`:

```bash
mkdir -p .claude
```

将以下内容写入 `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "relay-review": {
      "command": "python3",
      "args": ["script/mcp-server/server.py"],
      "cwd": "/你的实际路径/hsoft-data-manage",
      "env": {
        "GITHUB_TOKEN": "REDACTED",
        "GITHUB_REPOSITORY": "wang654993222/hsoft-data-manage"
      }
    }
  }
}
```

**重要:** 把 `"cwd"` 替换成你电脑上的实际项目路径！
- macOS/Linux 示例: `/Users/你的用户名/hsoft-data-manage`
- Windows WSL 示例: `/home/你的用户名/hsoft-data-manage`

查看当前路径: `pwd`

### 步骤 5: 配置用户级 settings

编辑 `~/.claude/settings.json`，在文件中添加以下两项（如果文件已有其他内容，保持原有内容不变，只添加这两行）：

```json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["relay-review"]
}
```

如果文件原本是空的 `{}`，则变成：

```json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["relay-review"]
}
```

三项配置缺一不可：
| 配置 | 位置 | 作用 |
|------|------|------|
| `mcpServers.relay-review` | `.claude/mcp.json` | 定义 relay-review MCP Server |
| `enableAllProjectMcpServers: true` | `~/.claude/settings.json` | 启用项目级 MCP Server |
| `enabledMcpjsonServers: ["relay-review"]` | `~/.claude/settings.json` | 允许 relay-review 启动 |

### 步骤 6: 验证安装

```bash
# 1. 验证 Python 环境
cd hsoft-data-manage
PYTHONPATH=script/mcp-server python3 -m pytest script/mcp-server/tests/ -q
# 预期输出: 21 passed

# 2. 验证 MCP Server 能连接 GitHub API
GITHUB_TOKEN=REDACTED \
GITHUB_REPOSITORY=wang654993222/hsoft-data-manage \
PYTHONPATH=script/mcp-server \
python3 -c "
import subprocess, json
proc = subprocess.Popen(
    ['python3', 'script/mcp-server/server.py'],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env={
        'GITHUB_TOKEN':'REDACTED',
        'GITHUB_REPOSITORY':'wang654993222/hsoft-data-manage',
        'PYTHONPATH':'script/mcp-server',
        'PATH':'/usr/bin:/usr/local/bin:/opt/homebrew/bin',
    },
    text=True
)
reqs = [
    json.dumps({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'test','version':'1.0'}}}),
    json.dumps({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'get_pr_context','arguments':{'pr_number':1}}}),
]
out, err = proc.communicate('\n'.join(reqs)+'\n')
for l in out.strip().split('\n'):
    r = json.loads(l)
    if r.get('id') == 2 and 'result' in r:
        d = json.loads(r['result']['content'][0]['text'])
        if d.get('ok'):
            print('MCP Server OK - PR #1 found: ' + d['data']['title'])
" 2>&1 | grep 'MCP Server OK'
# 预期输出: MCP Server OK - PR #1 found: ...
```

### 步骤 7: 重启 Claude Code Desktop

关闭 Claude Code Desktop 并重新打开。

验证 MCP 是否加载：
- 输入 `/mcp` → 应看到 `relay-review` 出现在项目级配置中
- 输入 "查询 PR #1 状态" → 应返回 PR 元数据

---

## 跨电脑接力审查流程

### 两机角色

```
机器 A (你的主电脑)        机器 B (另一台电脑)
     │                           │
     ├─ 创建/推送 PR              │
     │                           │
     ├─ Phase 1: 代码审查         │
     │  post_phase_result(1)     │
     │                           │
     │                         ├─ get_phase_result(1)
     │                         │  读取机器 A 审查结果
     │                         │
     │                         ├─ Phase 2: 接力复核
     │                         │  post_phase_result(2)
     │                         │
     │                         ├─ post_final_verdict
     │                         │  verdict=comment
     │                         │  (同一账号不能 approve)
     │                           │
     ├─ get_review_status        │
     │  overall=complete         │
     │                           │
```

### 具体对话指令

**机器 A 执行 Phase 1:**
```
用 get_pr_context 查询 PR #N 的状态
用 get_review_status 查询 PR #N 的审查状态
用 post_phase_result 把 Phase 1 代码审查结果发布到 PR #N
```

**机器 B 执行 Phase 2:**
```
用 get_review_status 查询 PR #N 的审查状态
用 get_phase_result 获取 PR #N 的 Phase 1 结果
用 post_phase_result 把 Phase 2 复核结果发布到 PR #N
用 post_final_verdict 发布最终判定 (verdict=comment)
```

### 能力矩阵

| 操作 | 同一 GitHub 账号 | 不同 GitHub 账号 |
|------|:---:|:---:|
| 读取 PR (`get_pr_context`) | ✅ | ✅ |
| 发布 Phase 审查 (`post_phase_result`) | ✅ | ✅ |
| 查询审查状态 (`get_review_status`) | ✅ | ✅ |
| 提取 Phase 结果 (`get_phase_result`) | ✅ | ✅ |
| Approve PR (`post_final_verdict approve`) | ❌ GitHub 限制 | ✅ |

---

## 5 个 MCP Tool 参考

| # | Tool | 参数 | 功能 |
|---|------|------|------|
| 1 | `get_pr_context` | `pr_number` | 拉取 PR 元数据 (title/state/draft/SHA/branch/author) |
| 2 | `get_review_status` | `pr_number` | 构建 Phase 1/2/3 审查状态矩阵 + next action |
| 3 | `get_phase_result` | `pr_number`, `phase` | 精确提取 Phase N 的审查结果 (SHA 匹配) |
| 4 | `post_phase_result` | `pr_number`, `phase`, `body`, `sha`, `dry_run?`, `from_local_file?` | 发布审查结果到 PR Comment (65K 截断) |
| 5 | `post_final_verdict` | `pr_number`, `verdict`, `summary` | 发布最终 PR Review (approve/request_changes/comment) |

---

## 故障排除

### MCP Server 未加载

1. 确认 `.claude/mcp.json` 中的 `cwd` 路径正确: `pwd`
2. 确认 `~/.claude/settings.json` 中有 `enableAllProjectMcpServers: true` 和 `enabledMcpjsonServers: ["relay-review"]`
3. 重启 Claude Code Desktop
4. 输入 `/mcp` 查看 relay-review 状态
5. 如果状态为 error，查看错误信息

### GitHub Token 无效

```bash
# 测试 Token 是否有效
curl -s -H "Authorization: Bearer 你的Token" https://api.github.com/user | python3 -c "import sys,json; print(json.load(sys.stdin).get('login','INVALID'))"
```

### Python 依赖问题

```bash
# 确认 Python 版本 >= 3.9
python3 --version

# 重新安装依赖
pip install --upgrade requests
```

### "Can not approve your own pull request"

这是 GitHub 自身的限制，不是 bug。解决方案:
- 使用 `post_final_verdict(verdict='comment')` 代替 `approve`
- 或者用不同的 GitHub 账号创建 Token

### 21 tests pass 但 MCP 仍然无法连接 GitHub

确保设置了正确的环境变量:
```bash
export GITHUB_TOKEN="REDACTED"
export GITHUB_REPOSITORY="wang654993222/hsoft-data-manage"
```
