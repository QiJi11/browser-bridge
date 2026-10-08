"""慢速抓取示例：经桥读列表页/详情页，带随机停顿；命中验证码/登录墙立即停。

用法：
  python slow_crawl.py <url> <out.json> [scroll_rounds]

为什么慢：这是"用真实浏览器"的代价与诚意——随机节奏 + 少量滚动，
比批量高速请求更接近人工浏览，也方便随时中断。
"""
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from ctl import call  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

STOP_WORDS = (
    "punish", "x5sec", "captcha", "login", "verify", "验证",
    "请登录", "访问被拒绝", "安全验证", "滑动验证",
)


def pause(a, b):
    time.sleep(random.uniform(a, b))


def blocked(d):
    head = ((d.get("url") or "") + " " + (d.get("text") or "")[:500]).lower()
    return any(s.lower() in head for s in STOP_WORDS)


def read(max_text=120000):
    r = call({"cmd": "read", "maxText": max_text})
    if not r.get("ok"):
        raise SystemExit("READ_FAIL " + json.dumps(r, ensure_ascii=False))
    return r["data"]


def slow_scroll(n):
    for _ in range(n):
        call({"cmd": "scroll", "dy": random.randint(600, 1100)})
        pause(1.5, 3.5)


def main():
    url, out = sys.argv[1], sys.argv[2]
    rounds = int(sys.argv[3]) if len(sys.argv) > 3 else 6
    r = call({"cmd": "open", "url": url})
    print("open", r.get("ok"), (r.get("data") or {}).get("title", r.get("error")))
    if not r.get("ok"):
        return
    pause(3, 6)
    d = read()
    if blocked(d):
        print("BLOCKED", d["url"][:120])
        return
    slow_scroll(rounds)
    d = read()
    if blocked(d):
        print("BLOCKED", d["url"][:120])
        return
    with open(out, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    print("ok", d["title"][:60], "| links", len(d["links"]), "| imgs", len(d["imgs"]), "| text", len(d["text"]))


if __name__ == "__main__":
    main()
