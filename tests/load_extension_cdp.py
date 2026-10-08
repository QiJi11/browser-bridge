"""无人值守加载扩展：通过 CDP 的 Extensions.loadUnpacked 加载未打包扩展。

为什么需要它：较新版本的 Chrome 已不支持命令行 `--load-extension` 直接加载
（实测 Chrome 154：加了这个参数扩展也不会加载，稳定版约 2025 年中起逐步移除）。
CI / 自动化测试里要加载自研扩展，用这个脚本。

前置：Chrome 以 CDP 调试端口启动，且带 `--enable-unsafe-extension-debugging`：

  chrome.exe --enable-unsafe-extension-debugging --remote-debugging-port=0 \\
             --user-data-dir=<独立profile目录> about:blank
  # 端口号读 <profile目录>/DevToolsActivePort 的第一行

用法：
  python load_extension_cdp.py <cdp_port> <extension_dir>

依赖：pip install websocket-client
"""
import json
import sys
import urllib.request

import websocket


def main():
    cdp_port, ext_dir = sys.argv[1], sys.argv[2]
    ver = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/version").read())
    print("browser:", ver.get("Browser"))
    ws = websocket.create_connection(ver["webSocketDebuggerUrl"], suppress_origin=True, timeout=20)
    ws.send(json.dumps({
        "id": 1,
        "method": "Extensions.loadUnpacked",
        "params": {"path": ext_dir},
    }))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == 1:
            if "error" in msg:
                print("FAILED:", msg["error"])
                raise SystemExit(1)
            print("loaded extension id:", msg["result"]["id"])
            return


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(1)
    main()
