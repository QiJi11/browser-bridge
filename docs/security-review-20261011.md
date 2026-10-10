# Browser Bridge 安全与恢复机制审查（2026-10-11）

状态：仅 PR #1 候选分支代码与模拟 CI 已验证；未运行真实 Chrome 或 Windows 设备验收，未合并部署。

## 原始 main 风险（基线 269ecf89cd）
- WS `/ext` 曾只校验 `chrome-extension://` Origin 前缀；其他扩展也能使用该前缀。
- poll `BRIDGE_EXTENSION_ORIGIN` 曾可选；控制端曾把 Token 放在 URL 查询参数中。
- 扩展曾申请全部 HTTPS 网站权限，且存在 `tabs.get` 与页面实际执行脚本之间的导航竞态。
- poll 以前先记 `lastTaskId`，再发送成功回执，断线或扩展休眠可能造成任务永远无法重试；CLI 可以静默覆盖当前未完成任务。

## 候选分支已经修复的内容
- 精确绑定 `BRIDGE_EXTENSION_ORIGIN`，未配置则拒绝启动；WS 同时拒绝第二个扩展连接。
- poll 的 Token 仅从 Header 读取，默认文件新建使用 0600（Windows 实际 ACL 另行确认），日志不打印完整回执。
- 默认 manifest 收窄到 HTTPS 示例站点；`ALLOWED_HOSTS` 在操作前、导航结束后和页面脚本实际执行时检查。
- WS 在开始导航前注册完成监听，poll 对新建时已加载完的标签页主动确认状态，减少丢事件导致的超时。
- poll 只有服务端确认 `task_done` 后才持久化 `lastTaskId`；CLI 拒绝覆盖待处理/损坏任务文件。
- 补充了真实服务进程、模拟 MV3 扩展、故障重试和导航竞态的自动化测试。

## 证据和限制
- GitHub Actions 合成测试能证明以上模拟路径；不能取代真实 Chrome MV3、登录态和 Windows 端到端验收。
- `Origin` 不是本机进程的强身份验证：本机恶意软件仍可能伪造 Origin；当前设计仍依赖本机可信边界与 token 文件 ACL。
- poll 只包含 `PING` / `OPEN_READ` 无写操作；失败重试是 at-least-once 倾向，不保证 exactly-once。未来新增写动作必须有服务器侧持久幂等/任务确认机制。
- 用户在首次启动时必须设置实际扩展 ID；自定义站点必须同步修改 manifest 和扩展内白名单。
- [ ] 真实 MV3 扩展 ID、断连恢复和快速导航的端到端验收。
- [ ] Windows 用户目录 token 文件 ACL 验证。
- [ ] 与授权浏览器环境隔离的安全确认，方可考虑合并。
