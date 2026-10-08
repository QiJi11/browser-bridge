# 生态与关键词调研（2026-10）

目的：给"本机服务 + 浏览器扩展 + localhost 通信，驱动真实浏览器"这套架构找到网络上的对应概念、关键词与竞品坐标。

## 一句话结论

**没有统一公认的标准名称。** 最可被理解的通用词是 **browser bridge**；2025 年后主流形态叫
**MCP server + Chrome extension**；而大部分"用你真实浏览器"的知名产品（Kimi WebBridge、Browser MCP、
Playwright MCP `--extension`）**实际都走 CDP（`chrome.debugger`）**——与本项目"零 CDP、零 debugger 权限"
的纯扩展 API 路线不同。

## 关键词 → 各自精确指向

| 关键词 | 指向 | 出处 |
|---|---|---|
| **browser bridge** / browser extension bridge | 最通用的社区叫法，泛指"扩展 ↔ 本机进程"桥 | [ykdojo/browser-bridge](https://github.com/ykdojo/browser-bridge)、[egnmosk/dsh-browser-bridge](https://github.com/egnmosk/dsh-browser-bridge) |
| **webbridge / 本地桥接服务** | Kimi 官方产品名（2026 已更名 "Kimi 浏览器扩展"，帮助路径仍为 kimi-webbridge） | [kimi.com/help/kimi-webbridge](https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-how-it-works) |
| **MCP server + Chrome extension** / browser MCP | 2025 后事实标准互操作层（MCP 客户端 ↔ 本地 server ↔ 扩展） | [browsermcp.io](https://browsermcp.io/)、[hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) |
| **WebSocket bridge chrome extension** | 描述传输模式：扩展 SW 开 WS 连回本机 | [dsh-browser-bridge](https://github.com/egnmosk/dsh-browser-bridge) |
| **Chrome Native Messaging** | 官方机制：扩展 ↔ 本机程序走 stdin/stdout；需 `nativeMessaging` 权限 + OS 注册 | [developer.chrome.com](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) |
| **CDP-over-extension** | 精确指"扩展用 `chrome.debugger` 暴露 CDP"的混合方案 | [playwright-crx](https://github.com/ruifigueira/playwright-crx) |
| **extension-based browser automation** | 泛指用扩展 API 驱动页面（含"Agent 跑在扩展内"类） | [nanobrowser](https://github.com/nanobrowser/nanobrowser) |

## 项目坐标（star 为 2026-10-08 快照）

| 项目 | 通道 | star | 说明 |
|---|---|---|---|
| [browser-use](https://github.com/browser-use/browser-use) | Playwright/CDP | 117k | 本地库+云浏览器；stealth 在付费云 |
| [Playwright](https://github.com/microsoft/playwright) | CDP 等 | 97k | 基座；[Playwright Extension](https://github.com/microsoft/playwright/tree/main/packages/extension) 申请 **debugger** |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Puppeteer/CDP | 53k | Google 官方，调试/性能向 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | CDP | 38k | `--extension` 连真实浏览器（debugger 权限 + token + 逐次批准） |
| [Stagehand v4](https://www.browserbase.com/blog/stagehand-v4) | CDP-in-extension | 26k | 远程浏览器场景 |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | 纯扩展内 Agent | 14k | 不用外桥 |
| [mcp-chrome](https://github.com/hangwin/mcp-chrome) | 扩展 + 本机 bridge(12306) | 12k | 复用登录态；部分工具用 Debugger API |
| [Browser MCP](https://github.com/BrowserMCP/mcp) | 扩展 + CDP | 7.2k | 作者在 HN 明说用 CDP |
| [Kimi WebBridge](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc) | 官方 daemon + 扩展（CDP） | ~20 万用户 | 支持 Claude Code/Codex 等本地 agent |
| [Claude for Chrome](https://claude.com/blog/claude-for-chrome) | 官方扩展 | — | 权限模型 + 提示注入分类器（23.6% → 11.2%） |

**纠偏**：宣称"用你真实浏览器、避开反爬"的方案里，含 Kimi 在内的多数仍是 CDP 通道。
"零 debugger 权限、纯 MV3 API"的成熟/头部项目在公开生态中**很少**——本仓库属于这一类。

## 社区分歧（扩展桥 vs CDP）

- **反 CDP 派**：`chrome.debugger` 无授权/鉴权机制，"机器上任何东西都能扫端口拿你所有 cookie"（HN 43613194 评论）；
  Google 也在推 LNA 权限限制网页访问本机（但 WS 未覆盖）。
- **挺 CDP 派**：能力强、标准；"复用真实 profile"并非扩展专利——`launchPersistentContext(userDataDir)` 同样可以（HN 43613194）。
  且 Browser MCP 被指是 playwright-mcp 的改版（Playwright 维护者在 HN 现场指出）。
- **纯扩展 API 的质疑**：Claude for Chrome 讨论串里有人追问"为何需要 debugger 权限而不是 content script"（HN 45030760）。
- **提示注入是共同短板**：本地执行并不解决提示注入（Anthropic 自己数据也只降到 11.2%）。

## 缺口与命名建议

- 该架构缺统一定名；若要给本项目这类"纯扩展 API + 本机反向驱动"起检索词，可用
  **"CDP-free browser extension bridge"** / **"extension-API-only browser bridge"**（自造限定词）。
- 相邻方向：**WebMCP**（网站主动向 agent 暴露工具，HN 讨论提及）——长期可能替代"页面逆向操作"叙事。

## 主要来源（均为实际抓取）

1. [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) 2. [SW 生命周期/WS 保活](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) 3. [LNA](https://developer.chrome.com/blog/local-network-access) 4. [externally_connectable](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable) 5. [MDN webdriver](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver) 6. [PortSwigger CSWSH](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking) 7. [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455) 8. [Heroku WS Security](https://devcenter.heroku.com/articles/websocket-security) 9. [Oligo 0.0.0.0 Day](https://www.oligo.security/blog/0-0-0-0-day-exploiting-localhost-apis-from-the-browser) 10. [HN 43613194](https://news.ycombinator.com/item?id=43613194) 11. [HN 45030760](https://news.ycombinator.com/item?id=45030760) 12. [Kimi WebBridge 帮助](https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-how-it-works) 13. [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) 14. GitHub REST API 星数（2026-10-08）
