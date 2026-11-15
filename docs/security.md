# 威胁模型与防护

## 这套桥暴露了什么

桥把"浏览器里的登录态"（= 你所有已登录的站点）变成可被本机进程调用的能力。攻击面有三层。

## 1. 网页攻击本机桥（最需要防的）

**威胁**：你随便打开的一个恶意页面，尝试连接 `ws://127.0.0.1:<port>` 或 `fetch('http://127.0.0.1:<port>')`。

**事实基础**：
- WebSocket 握手**不受同源策略保护**，页面可以跨站发起连接。CSWSH 的成因是"握手只依赖 cookie、无不可预测 token"（[PortSwigger: CSWSH](https://portswigger.net/web-security/websockets/cross-site-websocket-hijacking)）。
- RFC 6455 §10.2：服务器若不想被任意网页连接，**应当校验 Origin**，不符时回 403（[RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)）。
- 但 Origin 只是 advisory，**不能当鉴权**（[Heroku WebSocket Security](https://devcenter.heroku.com/articles/websocket-security)）。
- 浏览器侧防线还没到位：Chrome 的 Local Network Access（[developer.chrome.com/blog/local-network-access](https://developer.chrome.com/blog/local-network-access)）明确说明 **WebSocket 尚未纳入**；在没有它的版本上，恶意网页直连本机端口不会被拦。
- 公开案例：[Oligo "0.0.0.0 Day"](https://www.oligo.security/blog/0-0-0-0-day-exploiting-localhost-apis-from-the-browser)（2024-08，多个浏览器可被绕过访问本机服务）；第三方对 Kimi WebBridge 的审计结论 "No security boundary: Any localhost process can connect to port 10086"（[efrg123/kimi-webbridge](https://github.com/efrg123/kimi-webbridge)）。

**本项目的对策（代码里已实现）**：

| 机制 | 位置 | 说明 |
|---|---|---|
| 只绑 127.0.0.1 | `ws/server.py`、`poll/server.mjs` | 不对局域网/外网开放 |
| `/ctl` 拒绝带 Origin 的连接 | `ws/server.py` | 网页发起的 WebSocket **一定**带 Origin；本机进程不带 |
| `/ctl` 随机 token | `ws/server.py` | 启动生成、只写本机文件；`hmac.compare_digest` 比较 |
| `/ext` 只收 `chrome-extension://` Origin | `ws/server.py` | 网页 Origin 是 http(s):// |
| poll 侧 token（持久化） | `poll/server.mjs` | header `x-bridge-token` 或 query |
| poll CORS 只回显扩展 Origin | `poll/server.mjs` | 可选 `BRIDGE_EXTENSION_ORIGIN` 精确锁扩展 ID |
| 站点白名单 | 扩展 `ALLOWED_HOSTS` | 打开新页面的硬闸，默认近乎为空（fail-closed） |
| 写操作默认关 | 扩展 `allowWrite` | click 类动作需显式打开 |

**已知残余风险**：
- 恶意**扩展**（而非网页）可以连 `/ext`。多扩展共存的浏览器里，白名单机制管不住这个；
  如需要，把 `/ext` 的校验从"前缀 chrome-extension://"升级为"精确等于你的扩展 ID"（一行改动）。
- WS 模式的 token 每次重启轮换，控制端需重读文件；poll 模式 token 持久化，泄露后要手动删除 `.bridge_token` 轮换。

## 2. 桥被滥用（拿到桥 = 拿到你的浏览器）

**威胁**：本机上的其他进程/恶意软件读到 `.bridge_token` 后驱动你的浏览器。

**对策**：token 文件权限交给 OS（Windows 用户目录 ACL）；不要把 token 写进任何仓库、日志、聊天记录
（本仓库 `.gitignore` 已兜底）。这是"本机信任边界"内的问题，和任何 localhost 服务一样，
不存在比"本机进程互信"更强的保证。

## 3. 目标网站的反制

**不是安全威胁但会被当成威胁**：行为风控、验证码、封号。桥能规避的是**自动化标志位**层面：
无 `--enable-automation` / `--headless` / `--remote-debugging-port`（这些会让 `navigator.webdriver` 为真，
[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver)），无 CDP `Runtime.enable` 特征
（Cloudflare、DataDome 等主流反爬会探测，[rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)）。

**规避不了**：行为分析、扩展指纹（Chrome 官方警告扩展资源可被站点探测，[web_accessible_resources](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources)，
缓解用 `use_dynamic_url`）、以及操作节奏本身。HN 上的实战反馈：
"用自己登录态让 AI 控浏览器后开始吃验证码，最终若干站点封了我"（[HN 43613194](https://news.ycombinator.com/item?id=43613194)）。

**对策**：慢速 + 随机节奏（见 `ws/examples/slow_crawl.py`）、单账号低频、验证码/登录墙立即停，
把桥当"省事的操作员"而不是"高速爬虫"。

## 检查单（部署前过一遍）

- [ ] server 只监听 `127.0.0.1`（默认满足）
- [ ] `ALLOWED_HOSTS` 只填必要域名（默认近乎为空）
- [ ] `allowWrite` 保持 `false`，除非确实要点击类操作
- [ ] 不要把端口、token 暴露到任何公网/共享环境
- [ ] 浏览器是用户自己的日常浏览器 / 或专用 profile，不用来登录不该被驱动的账号
- [ ] **没有免 token 的旁路端点**（调试用的 RESET/COLLECT/EVAL 也要鉴权，否则 token 边界整体失效）
- [ ] 多实例部署时每个实例独立端口 + 独立数据目录，token 不共用
- [ ] 高频/批量操作前想清楚目标站点的容忍度（账号是你的，代价也是你的）
