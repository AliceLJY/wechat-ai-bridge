#!/usr/bin/env python3
"""Muse backend helper for wechat-ai-bridge (experimental, unofficial).

Run with muse-cli's own interpreter, which has its dependencies:
  $MUSE_PYTHON -I muse-helper.py new-thread <title>
  $MUSE_PYTHON -I muse-helper.py turn <thread-id> <timeout-s> [since-seq]   # message on stdin
  $MUSE_PYTHON -I muse-helper.py put <local> <remote>   # remote under workspace/wechat-in/
  $MUSE_PYTHON -I muse-helper.py get <remote> <local>   # remote under workspace/

Every command prints JSON lines on stdout. Only session.start, chat.history,
chat.stream, fs.write, fs.read and fs.stat are reached: no delete, no raw.
"""
import base64
import json
import os
import re
import sys
import time

os.environ.setdefault("MUSE_NO_UPDATE_CHECK", "1")
from muse_cli.cli import connect, load_config  # noqa: E402

CHUNK_UP = 40 * 1024     # Noise frames cap at 65535 bytes; base64 + JSON must fit
CHUNK_DOWN = 256 * 1024
MAX_FILE_BYTES = 20 * 1024 * 1024   # the bridge refuses to send anything larger
POLL_S = 4
DELIVERY_TIMEOUT_S = 90


def _json(gw, method, body, timeout=120):
    """Raw gateway envelope ({"ok": ..., "result": ...}); call_json unwraps it."""
    return json.loads(gw.request(method, body=body, timeout=timeout))


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def fail(message, code=1):
    emit({"type": "error", "message": message})
    sys.exit(code)


def _seq(e):
    return e.get("seq") or 0


def _payload(e):
    p = e.get("payload")
    return p if isinstance(p, dict) else {}


def _text(e):
    p = _payload(e)
    return p.get("display_text") or p.get("content") or ""


def is_final(e, after):
    """A finished assistant message: not the empty commentary Muse streams while
    working, not a proactive push (those carry reply_to_message_id)."""
    if e.get("event_name") != "message.assistant" or _seq(e) <= after:
        return False
    p = _payload(e)
    if e.get("reply_to_message_id") or p.get("reply_to_message_id"):
        return False
    if p.get("display_text_ready") is False or not _text(e).strip():
        return False
    return (p.get("metadata") or {}).get("message_kind") != "commentary"


def _find_id(obj):
    if isinstance(obj, dict):
        for key in ("session_id", "sessionId", "chat_id", "id"):
            if isinstance(obj.get(key), str) and obj[key]:
                return obj[key]
        for value in obj.values():
            found = _find_id(value)
            if found:
                return found
    return None


def new_thread(title):
    gw = connect(load_config())
    try:
        resp = gw.call_json("session.start", body={
            "method": "/api/session/start",
            "params": {"origin": "fresh", "lifecycle": "persistent", "title": title}})
    finally:
        gw.close()
    sid = _find_id(resp)
    if not sid:
        fail(f"session.start returned no id: {json.dumps(resp)[:300]}")
    emit({"type": "thread", "session_id": sid})


def turn(thread, timeout, since=""):
    text = sys.stdin.read()
    if not text.strip():
        fail("empty message")
    cfg = load_config()
    gw = connect(cfg)
    scope = {"session_id": thread}
    started = time.time()
    try:
        recent = sorted(gw.call_json("chat.history", body={"limit": 20, **scope})
                        .get("chat_events", []), key=_seq)
        baseline = max([_seq(e) for e in recent] or [0])
        # Replies that landed after the previous turn returned (a video finishing
        # late, say): the bridge cannot push on its own, so hand them over now.
        if since.strip().isdigit():
            for e in recent:
                if is_final(e, int(since)):
                    emit({"type": "missed", "seq": _seq(e), "text": _text(e)})

        gw._open("chat.stream", body={"items": [{"type": "text", "text": text}],
                                      "node_id": cfg["node_id"], "capabilities": {}, **scope})
        # Keep this socket open until the reply arrives: closing it right after
        # opening the stream drops the message (observed 2026-10-08).
        delivered = False
        deadline = started + int(timeout)
        while time.time() < deadline:
            time.sleep(POLL_S)
            try:
                evs = sorted(gw.call_json("chat.history", body={"limit": 20, **scope})
                             .get("chat_events", []), key=_seq)
            except Exception as exc:  # noqa: BLE001 - transient gateway errors: keep polling
                emit({"type": "heartbeat", "seconds": int(time.time() - started), "warning": str(exc)[:200]})
                continue
            if not delivered:
                delivered = any(e.get("event_name") == "message.user" and _seq(e) > baseline for e in evs)
                if not delivered and time.time() - started > DELIVERY_TIMEOUT_S:
                    fail("消息没有送达 Muse（90 秒内没出现在它的对话里），请重发一次", 5)
            finals = [e for e in evs if is_final(e, baseline)]
            if finals:
                emit({"type": "reply", "seq": max(_seq(e) for e in finals),
                      "text": "\n\n".join(_text(e) for e in finals),
                      "seconds": int(time.time() - started)})
                return
            emit({"type": "heartbeat", "seconds": int(time.time() - started), "delivered": delivered})
    finally:
        gw.close()
    fail(f"Muse 在 {timeout} 秒内没有回复。任务可能还在云端跑，下一条消息会带上它之后的回复", 4)


def put(local, remote):
    if not re.fullmatch(r"workspace/wechat-in/[\w.-]+", remote):
        fail("remote must be workspace/wechat-in/<name>")
    data = open(local, "rb").read()
    if len(data) > MAX_FILE_BYTES:
        fail(f"file too large: {len(data)} bytes")
    gw = connect(load_config())
    try:
        for i in range(0, max(len(data), 1), CHUNK_UP):
            r = _json(gw, "fs.write", {
                "path": remote, "overwrite": i == 0, "append": i > 0, "create_parent": True,
                "data_base64": base64.b64encode(data[i:i + CHUNK_UP]).decode()})
            if not r.get("ok"):
                fail(f"write failed: {json.dumps(r)[:300]}")
        size = _json(gw, "fs.stat", {"path": remote})["result"]["size"]
    finally:
        gw.close()
    if size != len(data):
        fail(f"size mismatch after upload: local {len(data)}, remote {size}", 3)
    emit({"type": "uploaded", "remote": remote, "bytes": size})


def get(remote, local):
    if not remote.startswith("workspace/") or ".." in remote.split("/"):
        fail("remote must be under workspace/")
    gw = connect(load_config())
    out, off = bytearray(), 0
    try:
        size = _json(gw, "fs.stat", {"path": remote})["result"]["size"]
        if size > MAX_FILE_BYTES:
            fail(f"{remote} is {size} bytes, over the 20MB WeChat limit")
        while True:
            r = _json(gw, "fs.read", {"path": remote, "offset": off, "len": CHUNK_DOWN})["result"]
            b = base64.b64decode(r["data_base64"])
            out += b
            off += len(b)
            if r.get("eof") or not b:
                break
    finally:
        gw.close()
    if len(out) != size:
        fail(f"size mismatch after download: remote {size}, got {len(out)}", 3)
    fd = os.open(local, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(out)
    emit({"type": "downloaded", "local": local, "bytes": len(out)})


if __name__ == "__main__":
    cmds = {"new-thread": new_thread, "turn": turn, "put": put, "get": get}
    if len(sys.argv) < 3 or sys.argv[1] not in cmds:
        fail(__doc__.strip(), 2)
    try:
        cmds[sys.argv[1]](*sys.argv[2:])
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - report every failure as one JSON line
        msg = f"{type(exc).__name__}: {exc}"
        if "auth" in msg.lower() or "401" in msg or "403" in msg:
            msg += "（Muse 登录 Cookie 可能过期了，需要重新取）"
        fail(msg[:500])
