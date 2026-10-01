"""vt — drive the composable vault tools from a shell, one call per command.

    python3 vt.py serve --world spec:worlds/w01.json --sock /tmp/x.sock &   # once
    python3 vt.py --sock /tmp/x.sock open            # a fresh copy of the world
    python3 vt.py --sock /tmp/x.sock turn "who's coming to the cabin?"
    python3 vt.py --sock /tmp/x.sock call 'search "cabin"'
    python3 vt.py --sock /tmp/x.sock call 'show (parties of #1)'
    python3 vt.py --sock /tmp/x.sock call done

`serve` wraps `tool-loop serve` (crates/candidates/src/bin/tool-loop.rs) in a
Unix-socket server so a shell user — a person, or an agent with a Bash tool —
can hold one session open across commands. Every request and reply is
appended to <sock>.log as JSON lines, raw.
"""
import argparse
import json
import os
import socket
import subprocess
import sys

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
BIN = os.path.join(REPO, "target", "release", "tool-loop")


def serve(a):
    child = subprocess.Popen([BIN, "serve", "--world", a.world], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, text=True, bufsize=1)
    if os.path.exists(a.sock):
        os.unlink(a.sock)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(a.sock)
    srv.listen(4)
    log = open(a.sock + ".log", "a", encoding="utf-8")
    print("ready", flush=True)
    while True:
        conn, _ = srv.accept()
        with conn:
            data = b""
            while not data.endswith(b"\n"):
                chunk = conn.recv(65536)
                if not chunk:
                    break
                data += chunk
            msg = data.decode().strip()
            if not msg:
                continue
            child.stdin.write(msg + "\n")
            child.stdin.flush()
            reply = child.stdout.readline()
            if not reply:
                reply = json.dumps({"error": "the tool server exited"}) + "\n"
            log.write(json.dumps({"req": json.loads(msg), "reply": json.loads(reply)}) + "\n")
            log.flush()
            conn.sendall(reply.encode())
            if json.loads(msg).get("op") == "quit":
                return


def ask(sock, msg):
    c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    c.connect(sock)
    c.sendall((json.dumps(msg) + "\n").encode())
    data = b""
    while not data.endswith(b"\n"):
        chunk = c.recv(65536)
        if not chunk:
            break
        data += chunk
    return json.loads(data.decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sock", default=os.environ.get("VT_SOCK"))
    ap.add_argument("cmd", choices=["serve", "open", "turn", "call", "end", "quit"])
    ap.add_argument("text", nargs="?", default="")
    ap.add_argument("--world", default="suite")
    a = ap.parse_args()
    if not a.sock:
        sys.exit("--sock or VT_SOCK is required")
    if a.cmd == "serve":
        return serve(a)
    msg = {"open": {"op": "open", "id": a.text}, "turn": {"op": "turn", "request": a.text},
           "call": {"op": "call", "line": a.text}, "end": {"op": "end_turn"},
           "quit": {"op": "quit"}}[a.cmd]
    r = ask(a.sock, msg)
    if "obs" in r:
        print(r["obs"] if r["obs"] else "(no output)")
        if r.get("end"):
            print("[turn ended: %s]" % r["end"])
    elif "today" in r:
        print(r["today"])
    elif "end" in r:
        print("[turn ended: %s]" % r["end"])
    elif "error" in r:
        print("ERROR:", r["error"])
    else:
        print("ok")


if __name__ == "__main__":
    main()
