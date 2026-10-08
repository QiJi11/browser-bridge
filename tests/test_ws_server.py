"""ws 桥（server.py）端到端测试：真实起进程 + 真实 WebSocket 双端。

覆盖：
  正向：扩展连 /ext → 控制端 /ctl 发命令 → 扩展回包 → 控制端收到
  反向（必须全部被拒/按预期报错）：
    * /ext 不带 chrome-extension:// Origin  → 1008 关闭
    * /ctl 不带 token                        → 1008 关闭
    * /ctl 带 Origin（模拟网页）             → 1008 关闭
    * 扩展未连接时 /ctl 发命令               → {"ok": false, "error": "extension not connected"}
    * 扩展连接但不回包                       → {"ok": false, "error": "extension reply timeout"}

运行：python -m pytest tests/test_ws_server.py -v
"""
import asyncio
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest
import websockets

ROOT = Path(__file__).resolve().parents[1]
WS_DIR = ROOT / "ws"
PORT = 28786  # 避开默认 18786，防止撞本机正在运行的服务
TOKEN_FILE = WS_DIR / "test.bridge_token"


@pytest.fixture(scope="module")
def server():
    env = {
        **os.environ,
        "BRIDGE_PORT": str(PORT),
        "BRIDGE_TOKEN_FILE": str(TOKEN_FILE),
        "BRIDGE_REPLY_TIMEOUT": "2",
    }
    proc = subprocess.Popen(
        [sys.executable, str(WS_DIR / "server.py")],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    # 等 token 文件出现（server 启动时会写）
    deadline = time.time() + 10
    while time.time() < deadline:
        if TOKEN_FILE.exists():
            time.sleep(0.5)  # 再给监听一点时间
            break
        if proc.poll() is not None:
            out = proc.stdout.read().decode("utf-8", "replace")
            raise RuntimeError("server exited early:\n" + out)
        time.sleep(0.1)
    else:
        raise RuntimeError("server did not start in 10s")
    yield proc
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    if TOKEN_FILE.exists():
        TOKEN_FILE.unlink()


def token() -> str:
    return TOKEN_FILE.read_text(encoding="utf-8").strip()


EXT_ORIGIN = {"Origin": "chrome-extension://" + uuid.uuid4().hex[:32]}


async def connect_ext():
    return await websockets.connect(f"ws://127.0.0.1:{PORT}/ext", additional_headers=EXT_ORIGIN)


async def connect_ctl(with_token=True, with_origin=False):
    headers = {"Origin": "https://evil.example"} if with_origin else None
    q = f"?token={token()}" if with_token else ""
    return await websockets.connect(
        f"ws://127.0.0.1:{PORT}/ctl{q}", additional_headers=headers
    )


def run(coro):
    return asyncio.run(coro)


# ── 反向用例 ──────────────────────────────────────────────

def test_ext_requires_extension_origin(server):
    async def go():
        # 不带 Origin
        try:
            ws = await websockets.connect(f"ws://127.0.0.1:{PORT}/ext")
            with pytest.raises(websockets.ConnectionClosed) as ei:
                await ws.recv()
            assert ei.value.rcvd is not None and ei.value.rcvd.code == 1008
        except websockets.InvalidStatus as e:
            assert e.response.status_code == 403  # 某些版本握手即拒
        # 带网页 Origin
        try:
            ws = await websockets.connect(
                f"ws://127.0.0.1:{PORT}/ext",
                additional_headers={"Origin": "https://evil.example"},
            )
            with pytest.raises(websockets.ConnectionClosed) as ei:
                await ws.recv()
            assert ei.value.rcvd is not None and ei.value.rcvd.code == 1008
        except websockets.InvalidStatus as e:
            assert e.response.status_code == 403
    run(go())


def test_ctl_requires_token(server):
    async def go():
        try:
            ws = await connect_ctl(with_token=False)
            with pytest.raises(websockets.ConnectionClosed) as ei:
                await ws.recv()
            assert ei.value.rcvd is not None and ei.value.rcvd.code == 1008
        except websockets.InvalidStatus as e:
            assert e.response.status_code == 403
    run(go())


def test_ctl_rejects_browser_origin(server):
    async def go():
        try:
            ws = await connect_ctl(with_origin=True)
            with pytest.raises(websockets.ConnectionClosed) as ei:
                await ws.recv()
            assert ei.value.rcvd is not None and ei.value.rcvd.code == 1008
        except websockets.InvalidStatus as e:
            assert e.response.status_code == 403
    run(go())


def test_ctl_without_extension_gets_error(server):
    async def go():
        ws = await connect_ctl()
        await ws.send(json.dumps({"cmd": "status"}))
        res = json.loads(await ws.recv())
        await ws.close()
        assert res == {"ok": False, "error": "extension not connected"}
    run(go())


def test_ctl_timeout_when_extension_silent(server):
    async def go():
        ext = await connect_ext()
        try:
            ws = await connect_ctl()
            await ws.send(json.dumps({"cmd": "status"}))
            # 扩展收到命令但不回包 → server 2 秒后回超时错误
            await asyncio.wait_for(ext.recv(), timeout=1)
            res = json.loads(await ws.recv())
            await ws.close()
            assert res == {"ok": False, "error": "extension reply timeout"}
        finally:
            await ext.close()
    run(go())


# ── 正向用例 ──────────────────────────────────────────────

def test_roundtrip(server):
    async def go():
        ext = await connect_ext()
        try:
            ws = await connect_ctl()
            await ws.send(json.dumps({"cmd": "status"}))
            raw = await asyncio.wait_for(ext.recv(), timeout=3)
            req = json.loads(raw)
            assert req["cmd"] == "status" and isinstance(req["id"], int)
            await ext.send(json.dumps({"id": req["id"], "ok": True, "data": {"url": "https://example.com/"}}))
            res = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
            await ws.close()
            assert res["ok"] is True and res["data"]["url"] == "https://example.com/" and res["id"] == req["id"]
        finally:
            await ext.close()
    run(go())


def test_ping_keepalive_does_not_resolve_pending(server):
    async def go():
        ext = await connect_ext()
        try:
            ws = await connect_ctl()
            await ws.send(json.dumps({"cmd": "status"}))
            req = json.loads(await asyncio.wait_for(ext.recv(), timeout=3))
            await ext.send(json.dumps({"type": "ping"}))  # 心跳不应被当回复
            await ext.send(json.dumps({"id": req["id"], "ok": True, "data": "pong"}))
            res = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
            await ws.close()
            assert res["data"] == "pong"
        finally:
            await ext.close()
    run(go())
