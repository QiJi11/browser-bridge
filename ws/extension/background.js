// Local WS Bridge — 扩展端（连接本机 ws://127.0.0.1:18786/ext）
//
// 设计要点（与 tb-bridge / boss-hunter 桥同源，通用化后）：
//   * 不申请 debugger 权限，不用 CDP；executeScript 默认隔离环境，不注入页面主世界
//   * ALLOWED_HOSTS 白名单是"打开新页面"的硬闸；read 只读当前标签页
//   * allowWrite=false 时 click 被拒绝（默认只读）
//   * MV3 service worker 保活三件套：WS 长连（Chrome 116+ 收发消息重置 idle 计时）、
//     chrome.alarms 兜底、浏览器启动/标签加载事件触发重连
//
// 改这两个常量即可对接你的目标站点：
const ALLOWED_HOSTS = [
  // "taobao.com",
  // "tmall.com",
  "example.com",
];
let allowWrite = false; // 需要点击类写操作时改成 true（并接受相应风险）

const WS_URL = "ws://127.0.0.1:18786/ext";
let ws = null;
let bridgeTabId = null;

function hostAllowed(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const h = parsed.hostname;
    return ALLOWED_HOSTS.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(WS_URL);
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    let reply;
    try { reply = { id: msg.id, ok: true, data: await handle(msg) }; }
    catch (e) { reply = { id: msg.id, ok: false, error: String((e && e.message) || e) }; }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  };
  ws.onclose = () => { ws = null; };
  ws.onerror = () => {};
}

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete") connect(); });
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  else connect();
}, 20000);
connect();

async function getTab() {
  if (bridgeTabId !== null) {
    try { return await chrome.tabs.get(bridgeTabId); } catch { bridgeTabId = null; }
  }
  // 桥不接管用户当前标签页，始终新开一个自己的标签页
  const t = await chrome.tabs.create({ url: "about:blank", active: true });
  bridgeTabId = t.id;
  return t;
}

async function getAllowedTab() {
  const tab = await getTab();
  if (!hostAllowed(tab.url || "")) throw new Error("bridge tab is outside ALLOWED_HOSTS");
  return tab;
}

function waitComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); resolve("timeout"); }, timeoutMs);
    function fn(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer); chrome.tabs.onUpdated.removeListener(fn); resolve("complete");
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
  });
}

async function run(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res ? res.result : null;
}

async function handle(msg) {
  switch (msg.cmd) {
    case "status": {
      const tab = await getTab();
      return { url: tab.url, title: tab.title, status: tab.status };
    }
    case "open": {
      if (!hostAllowed(msg.url || "")) {
        throw new Error("host not in ALLOWED_HOSTS: " + msg.url);
      }
      const tab = await getTab();
      await chrome.tabs.update(tab.id, { url: msg.url, active: true });
      const st = await waitComplete(tab.id);
      const t = await chrome.tabs.get(tab.id);
      if (!hostAllowed(t.url || "")) throw new Error("bridge tab redirected outside ALLOWED_HOSTS");
      return { load: st, url: t.url, title: t.title };
    }
    case "scroll": {
      const tab = await getAllowedTab();
      return run(tab.id, (dy) => { window.scrollBy({ top: dy, behavior: "smooth" }); return window.scrollY; }, [msg.dy || 800]);
    }
    case "read": {
      const tab = await getAllowedTab();
      return run(tab.id, (maxText) => {
        const links = [];
        document.querySelectorAll("a[href]").forEach((a) => {
          const t = (a.innerText || "").replace(/\s+/g, " ").trim();
          if (t.length >= 2) links.push({ href: a.href, text: t.slice(0, 300) });
        });
        const imgs = [...document.images]
          .map((i) => i.currentSrc || i.src)
          .filter((s) => s && !/avatar|icon|logo|sprite/i.test(s))
          .slice(0, 120);
        return {
          url: location.href,
          title: document.title,
          scrollY: window.scrollY,
          text: (document.body ? document.body.innerText : "").slice(0, maxText),
          links,
          imgs,
        };
      }, [msg.maxText || 60000]);
    }
    case "click": {
      if (!allowWrite) throw new Error("write actions disabled (allowWrite=false)");
      const tab = await getAllowedTab();
      return run(tab.id, (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { clicked: false, reason: "not found" };
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.innerText || "").slice(0, 80) };
      }, [msg.selector]);
    }
    default:
      throw new Error("unknown cmd: " + msg.cmd);
  }
}
