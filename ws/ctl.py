"""命令行控制端：通过本机桥在浏览器里执行一条命令。

用法：
  python ctl.py status
  python ctl.py open <url>
  python ctl.py scroll [dy]
  python ctl.py read <out.json> [maxText]
  python ctl.py click <selector>     # 需扩展侧 allowWrite=true
  python ctl.py raw '<json>'

token 从与 server.py 同目录的 .bridge_token 读取（server 每次启动重写）。
依赖：pip install websocket-client
"""
import json
import os
import sys

import websocket

sys.stdout.reconfigure(encoding="utf-8")

PORT = int(os.environ.get("BRIDGE_PORT", "18786"))
TOKEN_FILE = os.environ.get("BRIDGE_TOKEN_FILE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".bridge_token"
)


def call(req, timeout=120):
    token = open(TOKEN_FILE, encoding="utf-8").read().strip()
    ws = websocket.create_connection(
        f"ws://127.0.0.1:{PORT}/ctl?token={token}",
        timeout=timeout,
        suppress_origin=True,  # 控制端是普通进程，不带 Origin；带 Origin 会被桥拒绝
    )
    try:
        ws.send(json.dumps(req))
        return json.loads(ws.recv())
    finally:
        ws.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(1)
    cmd = sys.argv[1]
    if cmd == "status":
        print(json.dumps(call({"cmd": "status"}), ensure_ascii=False))
    elif cmd == "open":
        print(json.dumps(call({"cmd": "open", "url": sys.argv[2]}), ensure_ascii=False))
    elif cmd == "scroll":
        dy = int(sys.argv[2]) if len(sys.argv) > 2 else 800
        print(json.dumps(call({"cmd": "scroll", "dy": dy}), ensure_ascii=False))
    elif cmd == "read":
        max_text = int(sys.argv[3]) if len(sys.argv) > 3 else 60000
        res = call({"cmd": "read", "maxText": max_text})
        if res.get("ok"):
            with open(sys.argv[2], "w", encoding="utf-8") as f:
                json.dump(res["data"], f, ensure_ascii=False)
            d = res["data"]
            print("ok", d["url"][:100], "| links", len(d["links"]), "| text", len(d["text"]))
        else:
            print(json.dumps(res, ensure_ascii=False))
    elif cmd == "click":
        print(json.dumps(call({"cmd": "click", "selector": sys.argv[2]}), ensure_ascii=False))
    elif cmd == "raw":
        print(json.dumps(call(json.loads(sys.argv[2])), ensure_ascii=False))
    else:
        print(__doc__)
        raise SystemExit(1)
