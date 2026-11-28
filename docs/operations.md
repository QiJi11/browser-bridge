# 运维与故障排查（实测）

本文件记录"桥长期跑在真实账号上"之后才会暴露的问题，和 `README.md` 的快速开始互补。
所有条目都来自真实多实例部署，不是纸面推演。

## 1. 多实例共存

一台机器同时驱动多个浏览器账号（主号 / 副号 / 朋友号）时：

- **每个实例必须独立端口 + 独立数据目录**：`BRIDGE_PORT` 与 `BRIDGE_DATA_DIR` 成对设置。
  共用一个目录会让 `task.json` / `state.json` / `receipts.jsonl` 互相覆盖，表现为"任务莫名变成别的号的动作"。
- 实测端口分工示例：`17777` 主实例、`17780` / `17781` / `17782` / `17783` 各自一个账号，
  每个实例一个 `bridge-*/` 目录。
- **扩展侧的桥地址是硬编码常量**（`background.js` 顶部的 `http://127.0.0.1:<port>`），
  不存在自动发现。改端口 → 必须改扩展常量 → 重新加载扩展；只重启 server 不会生效。
- 浏览器 profile 不要混用：Edge 稳定版与 Edge Beta 是**两个不同的 user-data 目录**，
  登录态只存在其中一个里，装错 profile 会表现为"扩展在线但页面全是未登录"。

## 2. 任务与回执纪律

- **任务单就是一个文件**：`task.json` 由外部写入，server 只读。排障时可以直接写文件注入任务，
  不必起 `ctl.mjs`；写完等一个轮询周期即可。
- **`job_result` ≠ 完成**。`job_result` 只说明"动作有结果"，`task_done` 才是结案。
  结算、去重、计数一律只看 `task_done`，否则会把失败动作记成成功。
- `receipts.jsonl` 是 append-only 审计流水：按 `taskId` 能反查"谁领的、跑了多久、报了什么错"。
- 幂等靠扩展侧 `taskId` 去重——SW 被杀重启后同一任务不会重跑。反过来说，
  **想让同一任务重跑必须换 taskId**。

## 3. 已知故障（实测）

### 3.1 Service Worker 内的异步动作静默挂起

现象：server 有任务、扩展显示在线、`recent` 回执为空，页面没有任何变化。

实测某次 `COLLECT`：动作在 SW 里 `await` 的 Promise 永不 resolve——**没有开 tab、没有抛错、
没有任何回执**，服务端完全看不到失败。这类 bug 最贵，因为它伪装成"任务还没轮到"。

排查：

1. 看 `receipts.jsonl` 里该 `taskId` 有没有任何一条记录；**一条都没有 = 动作根本没跑起来**，
   不是网络问题也不是 server 问题。
2. 打开 `chrome://extensions` → 该扩展的 service worker 控制台看有没有未捕获异常。

对策（写扩展时必须遵守）：

- 动作本身要带超时（`Promise.race` + 定时 reject），不能无限 `await`。
- **错误路径必须发回执**（`*_err`），成功静默失败静默是反模式——服务端无法区分"慢"和"死"。

### 3.2 就绪集合被跨页消息污染 → `READONLY_EXTENSION_BUSY`

现象：明明只有一个标签页在跑，调用却返回"扩展忙"。

根因：内容脚本在每个页面都会发 `CS_READY`，如果扩展把它写进**全局** readySet，
换页后旧页面的就绪标记仍在，后续动作被判定为"有别的脚本在跑"。

对策：

- 忙状态按 `tabId` 记录，不要全局一个 boolean/set。
- 导航、切页、`tabs.onRemoved` 时清理对应条目。

### 3.3 免凭据旁路端点会击穿整个 token 边界

只要有一个端点不校验 token（典型是"顺手加的" `RESET` / `COLLECT` / `EVAL` 类调试接口），
任何本机进程都能用它驱动浏览器，token 就形同虚设。

规则：**所有端点统一鉴权**；确实要保留免鉴权接口时，把它当成"公网可见"来写文档和评审。

### 3.4 扩展装了不生效

- Edge：扩展页必须先打开"开发人员模式"开关，否则"加载已解压的扩展程序"按钮不可用/加载后不启用。
- 改端口后 403 / `Failed to fetch`：`host_permissions` 里只声明了旧端口，
  新端口不在白名单里，扩展的 `fetch` 被直接拦掉。改端口必须同步 `manifest.json`。

### 3.5 回执"看起来发了但没落盘"

server 侧写 `state.json` 有 try/catch 静默吞异常的历史写法。判断是否真落盘，
要看 `receipts.jsonl` 行数变化，而不是看 HTTP 200。

## 4. 排障顺序（10 分钟内定位）

1. `curl http://127.0.0.1:<port>/health` —— server 活着吗
2. `chrome://extensions` 里该扩展的 service worker 是否在运行（点进去看 console）
3. 注入一个 `PING` 任务 → 等一个轮询周期（alarms 最小 30s）→ `receipts` 应该 +2 条
4. 没回执 → 扩展侧没跑（看 console、看 host_permissions、看扩展是否启用）
5. 有 `job_result` 没 `task_done` → 看扩展的 catch 分支和 `error` 字段
6. 都有但业务不对 → 看 `data` 里的原始返回，别在 server 侧猜
