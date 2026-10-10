# Browser Bridge 授权边界审查（2026-10-11）
状态：静态代码检查；未执行本地或真实浏览器测试。本文为审查证据，不宣称漏洞已被利用或修复。

## 已确认（main@269ecf89cd）
- `ws/server.py` 中 /ext 握手仅检查 `origin.startswith("chrome-extension://")`（约第 53 行），未绑定唯一扩展 ID；`/ctl` 使用随机 token 且拒绝带 Origin 的连接。
- `poll/server.mjs` 的 `originOk` 在 `BRIDGE_EXTENSION_ORIGIN` 未配置时也接受任意 `chrome-extension://` 前缀（约第 65–69 行）。poll 另外检查 `x-bridge-token` 或查询字符串 token。
- 服务监听 127.0.0.1；ws 的 `allowWrite` 默认 false，打开新站点受 ALLOWED_HOSTS 限制。
- README 与 docs/security.md 已披露上述残余风险。这不是新增发现的隐蔽功能。

## 需防御性核实
1. 使 /ext 默认必须匹配已登记的唯一扩展 ID，并考虑是否对 WS 扩展连接提供独立凭据或握手挑战；兼容开发者重新加载扩展的 ID 管理。
2. poll 模式验证：启用唯一 BRIDGE_EXTENSION_ORIGIN 后，正确扩展成功、其他扩展 Origin 403、普通网页 Origin 403；无 Origin 的本机 CLI 仍须通过 token 校验。
3. 确认所有数据读取操作的目标标签和主机权限范围；避免连接其他登录网站时由任意本机 agent 跨域读取无关私密数据。
4. 检查 token 文件的实际操作系统权限、重启行为、日志脱敏、query token 在日志/进程监控中的泄露面。
5. 增加负向测试：跨扩展连接、错误 token、超时、重复任务/回执及写操作默认拒绝。
6. 在隔离 Chrome profile 和仿真网页验证后才可申请接入真实登录态。

## 不在本次审查范围
不连接浏览器、不采集 cookies、不执行页面操作、不更改权限、不运行或部署桥。代码变更应另起分支并附测试日志。
