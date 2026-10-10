# browser-bridge

本机脚本 / AI agent 通过 localhost 桥，让**你自己装的 Chrome MV3 扩展**在**真实登录态浏览器**里干活。

不用 CDP、不用 WebDriver、不申请 `debugger` 权限。扩展在真实 profile 的真实标签页里执行，
本机任何语言（Python / Node / 任何能开 WebSocket 或发 HTTP 的进程）都能调用。

```
本机脚本 / AI agent
   │  ws://127.0.0.1:18786/ctl?token=…        ┌───────────────────────────┐
   └────────────►  bridge server（本机进程）  │  Chrome（真实 profile）    │
                     ▲                        │   ┌────────────────────┐  │
                     │  ws://…/ext            └───│ MV3 扩展(background)│  │
                     └────────────────────────────│  tabs/scripting API │  │
                                                  └────────────────────┘  │
```

## 两种模式

| | `ws/`（推模式） | `poll/`（拉模式） |
|---|---|---|
| 通道 | WebSocket 长连接 | HTTP 轮询（chrome.alarms） |
| 延迟 | 低，实时 | 一个轮询周期（≥30s） |
| 断连恢复 | 自动重连 | 任务文件持久化，失败可重试；只读动作可能重复执行 |
| 任务语义 | 无状态转发（一问一答） | 单任务槽位 + 回执流水 + 成功确认后标记完成（非 exactly-once） |
| 适合 | 交互式读取、爬取、调试 | 无人值守批量任务、要审计的场景 |

选型一句话：**要实时互动用 `ws/`，要"发单-执行-留痕"用 `poll/`。**

## 快速开始

### ws 模式

```bash
pip install websockets websocket-client
```

1. Chrome → `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选 `ws/extension/`；复制该扩展的 **32 位 ID**。
2. 启动服务前**必须绑定唯一扩展 Origin**（不要写真实 token / 扩展 ID 到 Git）：

   ```powershell
   $env:BRIDGE_EXTENSION_ORIGIN = "chrome-extension://<扩展ID>"
   python ws/server.py
   ```

   bash 下可用 `BRIDGE_EXTENSION_ORIGIN="chrome-extension://<扩展ID>" python ws/server.py`。
   未设置或 ID 格式错误时服务拒绝启动（fail-closed）。
3. 默认仅允许 `example.com` 的 HTTPS 页面。如需其他站点，**同时**调整 `ws/extension/background.js` 中的 `ALLOWED_HOSTS` 和 `ws/extension/manifest.json` 中的 `host_permissions`，重新加载扩展，确保权限最小化。
4. 验证：

```bash
python ws/ctl.py status                 # 应返回扩展侧标签页的 url/title
python ws/ctl.py open https://example.com
python ws/ctl.py read out.json          # 读当前页正文/链接/图片 → out.json
python ws/examples/slow_crawl.py https://example.com out.json 8   # 慢速抓取示例
```

### poll 模式

1. 先在 `chrome://extensions` 加载 `poll/extension/`，复制扩展 ID。
2. 在控制台启动时指定其 Origin：

   ```powershell
   $env:BRIDGE_EXTENSION_ORIGIN = "chrome-extension://<扩展ID>"
   node poll/server.mjs
   ```

   bash 下可用 `BRIDGE_EXTENSION_ORIGIN="chrome-extension://<扩展ID>" node poll/server.mjs`。
   未设置或 ID 格式错误时服务拒绝启动。token 保存于 `poll/.bridge_token`，重启不会自动轮换。
3. 在扩展 Service Worker 控制台配置一次 token：`chrome.storage.local.set({ bridgeToken: '<poll/.bridge_token 的内容>' })`，**不要把 token 粘贴进 Git / 聊天或公开日志**。
4. 如需其他站点，同时修改 `poll/extension/background.js` 的 `ALLOWED_HOSTS` 和 `poll/extension/manifest.json` 的 HTTPS `host_permissions` 并重新加载扩展；仅保留必要域名。
5. 验证：

```bash
node poll/ctl.mjs task PING
node poll/ctl.mjs task OPEN_READ '{"url":"https://example.com"}'
node poll/ctl.mjs receipts 5            # 看回执
node poll/ctl.mjs status
```

**任务保护**：`ctl.mjs task` 会拒绝覆盖未完成的 `task.json`；先执行 `status`、查看 `receipts`，确认后才通过 `reset` 明确放弃任务。失败后的 PING/OPEN_READ 允许重试，但不保证 exactly-once；未来新增任何写操作都必须设计服务端幂等键。

## 安全模型（必读）

这套桥把"浏览器里的登录态"暴露给了本机进程，边界必须清楚（详见 [docs/security.md](docs/security.md)）：

- **只绑回环地址**：server 永远监听 `127.0.0.1`，不对局域网/外网开放。
- **控制端 token**：`/ctl`（ws）与整个 poll server 需要 token；token 是启动时随机生成、只落本机文件，
  网页拿不到。poll 模式的 token 持久化在 `.bridge_token`（删掉即轮换，扩展要重新配置）。
- **Origin 校验**：`/ctl` 拒绝任何带 `Origin` 的连接（网页发起的 WebSocket 必带 Origin）；
  `/ext` 与 poll 服务器均强制要求 `BRIDGE_EXTENSION_ORIGIN` 精确匹配已加载扩展 ID。其他扩展即使使用同样的 `chrome-extension://` 前缀也被拒绝；单靠 Origin 仍不能防御完全控制本机的进程。
- **站点白名单**：扩展侧的 `ALLOWED_HOSTS` 与 manifest `host_permissions` 是两道独立边界。默认只允许示例 HTTPS 站点。除调用前与跳转后校验外，读取/滚动/点击还在页面实际脚本执行时再次校验，阻断导航竞态。变更目标域名必须同步修改两处。
- **写操作默认关闭**：`ws` 模式的 `click` 需要把 `allowWrite` 改成 `true` 才生效。
- **别把桥暴露给公网**：浏览器对 localhost 的访问限制（Chrome 的 Local Network Access）目前
  **尚未覆盖 WebSocket**，恶意网页直连你本机端口这件事不能指望浏览器拦，token + Origin 是硬要求。

## 这个方案在网络上的对应概念（便于检索）

没有统一术语；社区/厂商用过的名字：

- **browser bridge / browser extension bridge** —— 最通用的社区叫法（GitHub 上大量同类自研项目用这个词）
- **webbridge / 本地桥接服务** —— Kimi 官方产品名（Kimi WebBridge，2026 年更名 Kimi 浏览器扩展）
- **MCP server + Chrome extension / browser MCP** —— 2025 年后的事实标准互操作层（Browser MCP、mcp-chrome 等）
- **Chrome Native Messaging** —— 官方"扩展 ↔ 本机程序"机制（stdio，需注册表/目录注册），本项目不用它，用 localhost WS

**重要区别**：Kimi WebBridge、Browser MCP、Playwright MCP 的 `--extension` 模式虽然都常被宣传为"用你的真实浏览器"，
但它们实际走 CDP（申请 `chrome.debugger`）。本项目（及最初的 tb-bridge / boss-hunter 桥）是**零 CDP、零 debugger 权限**，
只用 MV3 原生 API（`tabs` / `scripting` / `alarms`）——公开生态里这类"纯扩展 API + 本机反向驱动"的成熟代表项目很少。

完整调研（含各项目 star 量级、HN 争论、防护惯例、来源链接）见 [docs/landscape.md](docs/landscape.md)。

## 与 CDP/Playwright 的取舍（为什么有人选桥）

用桥的好处：

- 复用真实 profile 与登录态；无 `--remote-debugging-port`、无 `navigator.webdriver`、无 CDP `Runtime.enable` 特征
- 扩展权限面小（不申请 debugger），用户可随时在浏览器里接管/关掉
- 行为更像人：可以天然加随机节奏（见 `ws/examples/slow_crawl.py`）

代价：

- 能力上限 = 扩展 API 的上限（跨域请求、抓包、精确网络拦截等做不到）
- 需要用户装扩展 + 保持浏览器开着
- 反检测只是"少特征"，不是隐身：行为风控、扩展指纹、账号本身的风险仍然存在

## 目录

```
ws/                   推模式（WebSocket，低延迟）
  server.py           本机桥服务：/ext（扩展）+ /ctl（控制端）
  ctl.py              命令行控制端
  extension/          Chrome MV3 扩展（tabs/scripting/alarms，无 debugger）
  examples/slow_crawl.py  慢速抓取示例（随机停顿 + 验证码/登录墙熔断）
poll/                 拉模式（HTTP 轮询，任务单 + 回执）
  server.mjs          任务桥服务：/task 领任务、/result 回执、receipts.jsonl 审计流水
  ctl.mjs             控制端：写任务 / 看状态 / 看回执
  extension/          MV3 扩展：轮询领任务、服务端确认后标记完成、串行执行
docs/
  security.md         威胁模型与防护
  landscape.md        生态与关键词调研
tests/
  test_ws_server.py   端到端测试（正向 + 反向），pytest
  test_poll_server.mjs 端到端测试（正向 + 反向），node --test
```

## 测试

```bash
python -m pytest tests/test_ws_server.py -v     # ws：9 用例（模拟扩展）
node --test tests/test_poll_server.mjs tests/test_poll_cli.mjs tests/test_poll_extension.mjs tests/test_injected_origin_guard.mjs  # 22 用例，纯模拟
```

测试用独立端口（28786/28777）与临时目录，不碰默认端口和本目录数据。

### 历史真实浏览器验证（旧版，当前安全加固分支尚未重新做）

除单元测试外，两种模式都在真实 Chrome（154.0.8037.98）+ 真实加载的扩展上跑过完整闭环：

- **ws**：`status` / `open https://example.com`（load complete）/ `read`（正文+链接）；
  白名单反向验证：`open https://www.google.com` → 被拒（host not in ALLOWED_HOSTS）
- **poll**：`PING` 与 `OPEN_READ` 任务经 alarm 自然轮询被领取 → 执行 → `job_result` +
  `task_done` 回执写入 receipts.jsonl → task.json 结案

### 加载扩展的两个坑（实测）

1. **命令行 `--load-extension` 在新版 Chrome 已失效**（实测 154 不加载）。日常用
   `chrome://extensions` 开发者模式手动加载；自动化环境用
   `--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked`
   （脚本：[tests/load_extension_cdp.py](tests/load_extension_cdp.py)）。
2. **poll 扩展的 `host_permissions` 必须包含 `http://127.0.0.1/*`**，否则扩展 SW 的
   `fetch` 被拦（报 "Failed to fetch"，且失败会被 catch 吞掉、表现为"任务没反应"）。
   manifest 已内置；若改端口或改走 https 本地服务，记得同步改 host_permissions。
   （ws 模式的 WebSocket 连接不受此限制，实测无需声明。）

## 来源

抽取自作者本地两条实战链路（taobao 只读桥 / boss-hunter 投递桥），去业务化后的通用版本。
两者均在真实浏览器 + 真实账号下长期跑过。
