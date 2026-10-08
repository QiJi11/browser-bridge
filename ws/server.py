"""本机桥服务（推模式）：只监听回环地址。

    /ext  —— 浏览器扩展连入（只接受 chrome-extension:// Origin；同一时刻保留一个连接）
    /ctl  —— 本机脚本 / agent 连入发命令；服务按 id 转发给扩展，再把结果回传

安全边界（详见 docs/security.md）：
  * 只绑定 127.0.0.1，不对外网开放
  * /ctl 需要启动时生成的随机 token；token 只写本机文件，网页拿不到
  * /ctl 拒绝任何带 Origin 的连接（网页发起的 WebSocket 一定带 Origin）
  * /ext 只接受 chrome-extension:// 起源

环境变量：
  BRIDGE_PORT           默认 18786
  BRIDGE_REPLY_TIMEOUT  单条命令等待扩展回复的秒数，默认 90
  BRIDGE_TOKEN_FILE     token 落盘路径，默认与本文件同目录的 .bridge_token

依赖：pip install websockets
"""
import asyncio
import hmac
import itertools
import json
import os
import secrets
import sys
from urllib.parse import parse_qs, urlsplit

import websockets

sys.stdout.reconfigure(encoding="utf-8")

HOST = "127.0.0.1"
PORT = int(os.environ.get("BRIDGE_PORT", "18786"))
REPLY_TIMEOUT = float(os.environ.get("BRIDGE_REPLY_TIMEOUT", "90"))
TOKEN_FILE = os.environ.get("BRIDGE_TOKEN_FILE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".bridge_token"
)
# 每次启动生成随机口令，只写到本机文件；控制端读文件拿口令。
TOKEN = secrets.token_urlsafe(24)

ext = None
pending = {}
seq = itertools.count(1)


async def handler(conn):
    global ext
    parts = urlsplit(conn.request.path)
    path = parts.path
    origin = conn.request.headers.get("Origin", "") or ""
    if path == "/ext":
        # 普通网页的 Origin 是 http(s)://，只有扩展的 Origin 是 chrome-extension://
        if not origin.startswith("chrome-extension://"):
            await conn.close(code=1008, reason="forbidden")
            return
        ext = conn
        print("extension connected", flush=True)
        try:
            async for raw in conn:
                msg = json.loads(raw)
                if msg.get("type") == "ping":
                    continue
                fut = pending.pop(msg.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(msg)
        finally:
            if ext is conn:
                ext = None
            print("extension disconnected", flush=True)
    elif path == "/ctl":
        # 控制端必须带口令，且不能来自网页（网页连接一定带 Origin）
        token = parse_qs(parts.query).get("token", [""])[0]
        if origin or not hmac.compare_digest(token, TOKEN):
            await conn.close(code=1008, reason="forbidden")
            return
        async for raw in conn:
            req = json.loads(raw)
            if ext is None:
                await conn.send(json.dumps({"ok": False, "error": "extension not connected"}))
                continue
            rid = next(seq)
            req["id"] = rid
            fut = asyncio.get_running_loop().create_future()
            pending[rid] = fut
            await ext.send(json.dumps(req))
            try:
                res = await asyncio.wait_for(fut, timeout=REPLY_TIMEOUT)
            except asyncio.TimeoutError:
                pending.pop(rid, None)
                res = {"ok": False, "error": "extension reply timeout"}
            await conn.send(json.dumps(res, ensure_ascii=False))
    else:
        await conn.close()


async def main():
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        f.write(TOKEN)
    async with websockets.serve(handler, HOST, PORT, max_size=32 * 1024 * 1024):
        print(f"bridge listening ws://{HOST}:{PORT}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
