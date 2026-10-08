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
| 断连恢复 | 自动重连 | 天然耐断，server 重启不丢任务 |
| 任务语义 | 无状态转发（一问一答） | 任务单 + 回执流水 + taskId 幂等 |
| 适合 | 交互式读取、爬取、调试 | 无人值守批量任务、要审计的场景 |

选型一句话：**要实时互动用 `ws/`，要"发单-执行-留痕"用 `poll/`。**

## 快速开始

### ws 模式

```bash
pip install websockets websocket-client
python ws/server.py                     # 监听 127.0.0.1:18786，token 写入 ws/.bridge_token
```

1. Chrome → `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选 `ws/extension/`
2. 编辑 `ws/extension/background.js` 顶部的 `ALLOWED_HOSTS`，填你的目标站点域名（默认只允许 example.com）
3. 验证：

```bash
python ws/ctl.py status                 # 应返回扩展侧标签页的 url/title
python ws/ctl.py open https://example.com
python ws/ctl.py read out.json          # 读当前页正文/链接/图片 → out.json
python ws/examples/slow_crawl.py https://example.com out.json 8   # 慢速抓取示例
```

### poll 模式

```bash
node poll/server.mjs                    # 监听 127.0.0.1:17777，token 写入 poll/.bridge_token（持久化，重启不变）
```

1. 加载扩展 `poll/extension/`；在它的 Service Worker 控制台执行一次：
   `chrome.storage.local.set({ bridgeToken: '<poll/.bridge_token 的内容>' })`
2. 编辑 `poll/extension/background.js` 顶部 `ALLOWED_HOSTS` 与 `STAGGER_MS`
3. 验证：

```bash
node poll/ctl.mjs task PING
node poll/ctl.mjs task OPEN_READ '{"url":"https://example.com"}'
node poll/ctl.mjs receipts 5            # 看回执
node poll/ctl.mjs status
```

## 安全模型（必读）

这套桥把"浏览器里的登录态"暴露给了本机进程，边界必须清楚（详见 [docs/security.md](docs/security.md)）：

- **只绑回环地址**：server 永远监听 `127.0.0.1`，不对局域网/外网开放。
- **控制端 token**：`/ctl`（ws）与整个 poll server 需要 token；token 是启动时随机生成、只落本机文件，
  网页拿不到。poll 模式的 token 持久化在 `.bridge_token`（删掉即轮换，扩展要重新配置）。
- **Origin 校验**：`/ctl` 拒绝任何带 `Origin` 的连接（网页发起的 WebSocket 必带 Origin）；
  `/ext` 只接受 `chrome-extension://` 起源；poll 的 CORS 只对 `chrome-extension://` 回显。
  需要更紧时给 `poll/server.mjs` 设 `BRIDGE_EXTENSION_ORIGIN=chrome-extension://<你的扩展ID>`。
- **站点白名单**：扩展侧的 `ALLOWED_HOSTS` 是打开新页面的硬闸，默认几乎为空——**必须自己填**。
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
  extension/          MV3 扩展：轮询领任务、taskId 幂等、串行执行
docs/
  security.md         威胁模型与防护
  landscape.md        生态与关键词调研
tests/
  test_ws_server.py   端到端测试（正向 + 反向），pytest
  test_poll_server.mjs 端到端测试（正向 + 反向），node --test
```

## 测试

```bash
python -m pytest tests/test_ws_server.py -v     # ws：7 用例（含 5 个反向）
node --test tests/test_poll_server.mjs          # poll：8 用例（含 5 个反向）
```

测试用独立端口（28786/28777）与临时目录，不碰默认端口和本目录数据。

## 来源

抽取自作者本地两条实战链路（taobao 只读桥 / boss-hunter 投递桥），去业务化后的通用版本。
两者均在真实浏览器 + 真实账号下长期跑过。
