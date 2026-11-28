// Local Poll Bridge — 扩展端（轮询 http://127.0.0.1:17777）
//
// 与 ws 模式的区别：扩展主动轮询领任务，天然耐断连（server 重启/扩展休眠都不丢），
// 适合无人值守批量任务 + 需要回执审计的场景。
//
// 恢复语义：task_done 获得服务端成功回执后才记 lastTaskId；若中途断线可再次尝试。
// 当前动作只支持 PING / OPEN_READ；未来若新增写操作，必须先设计服务端幂等键。
// 首次使用：在扩展的 Service Worker 控制台执行
//   chrome.storage.local.set({ bridgeToken: '<server 端 .bridge_token 文件内容>' })
//
// 加一个新动作：在 handleAction 的 switch 里加 case，返回结果对象即可；
// 执行完自动 POST job_result + task_done。
//
// 改这两个常量对接目标站点：
const ALLOWED_HOSTS = [
  // "example.org",
  "example.com",
];
const STAGGER_MS = 0; // 任务内多步骤之间的间隔（ms），批量操作场景建议 ≥60000

const BRIDGE_URL = "http://127.0.0.1:17777";
const POLL_ALARM = "poll_bridge";
const KA_ALARM = "poll_bridge_ka";

let running = false; // 本 SW 实例内的串行闸

async function getToken() {
  const { bridgeToken } = await chrome.storage.local.get("bridgeToken");
  return bridgeToken || "";
}

async function bridgeFetch(path, opts = {}) {
  const r = await fetch(`${BRIDGE_URL}${path}`, {
    ...opts,
    headers: { "x-bridge-token": await getToken(), "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) {
    if (r.status === 403) throw new Error("bridge 403: token missing/wrong (see README for bridgeToken setup)");
    throw new Error("bridge " + r.status);
  }
  return r.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

// ── 动作实现 ───────────────────────────────────────────────
async function handleAction(task) {
  switch (task.action) {
    case "PING":
      return { pong: true, at: new Date().toISOString(), sw: "alive" };
    case "OPEN_READ": {
      if (!hostAllowed(task.url || "")) throw new Error("host not in ALLOWED_HOSTS: " + task.url);
      const tab = await chrome.tabs.create({ url: task.url, active: true });
      await waitComplete(tab.id);
      const current = await chrome.tabs.get(tab.id);
      if (!hostAllowed(current.url || "")) throw new Error("bridge tab redirected outside ALLOWED_HOSTS");
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (maxText, hosts) => {
          // Validate in the actual document, not just tabs.get: redirects can race script injection.
          const h = location.hostname;
          if (location.protocol !== "https:" || !hosts.some((d) => h === d || h.endsWith("." + d)))
            throw new Error("page navigated outside ALLOWED_HOSTS");
          return {
            url: location.href,
            title: document.title,
            text: (document.body ? document.body.innerText : "").slice(0, maxText),
          };
        },
        args: [task.maxText || 20000, ALLOWED_HOSTS],
      });
      return res ? res.result : null;
    }
    default:
      throw new Error("unknown action: " + task.action);
  }
}

function waitComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    function finish(status) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(fn);
      resolve(status);
    }
    function fn(id, info) {
      if (id === tabId && info.status === "complete") finish("complete");
    }
    chrome.tabs.onUpdated.addListener(fn);
    // tabs.create may return after the document already finished loading.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish("complete");
    }).catch(() => finish("error"));
  });
}

// ── 任务循环 ───────────────────────────────────────────────
async function tick() {
  if (running) return;
  running = true;
  try {
    const task = await bridgeFetch("/task");
    if (!task || task.action === "NONE" || !task.id) return;
    const { lastTaskId } = await chrome.storage.local.get("lastTaskId");
    if (lastTaskId === task.id) return; // 已确认结案的任务无需重复处理

    let ok = true, data = null, error = null;
    try {
      data = await handleAction(task);
    } catch (e) {
      ok = false;
      error = String((e && e.message) || e);
    }
    await bridgeFetch("/result", {
      method: "POST",
      body: JSON.stringify({ type: "job_result", taskId: task.id, action: task.action, ok, data, error }),
    });
    if (STAGGER_MS) await sleep(STAGGER_MS);
    await bridgeFetch("/result", {
      method: "POST",
      body: JSON.stringify({ type: "task_done", taskId: task.id, ok }),
    });
    // 只有服务端确认结案后才能持久标记；否则断线/休眠会令任务永久卡死。
    await chrome.storage.local.set({ lastTaskId: task.id });
  } catch (e) {
    // server 未起/网络抖动：留给下一次轮询，不抛
  } finally {
    running = false;
  }
}

// 轮询（alarms 最小周期 0.5 分钟）+ keepalive 兜底
chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.create(KA_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === POLL_ALARM) tick();
  if (a.name === KA_ALARM) { try { chrome.storage.local.get(null, () => {}); } catch {} }
});
chrome.runtime.onStartup.addListener(() => tick());
chrome.runtime.onInstalled.addListener(() => tick());
tick();
