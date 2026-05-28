#!/usr/bin/env python3
"""Read a process's raw argv bytes on macOS.

macOS's `ps -ww -p $pid -o args=` cat-v-escapes every byte >= 0x80, which
mangles UTF-8 multi-byte sequences in commit subjects. The steering hook
needs exact-byte argv to recover the subject so the strict subject-match
check in check.sh agrees with what the hook wrote to STEERING.md. This
helper reads KERN_PROCARGS2 via sysctl(3) so non-ASCII commit subjects
survive intact. See issue #140.

Linux's `/proc/<pid>/cmdline` is already exact-byte; this helper is the
macOS-side equivalent.

CLI:
    python3 argv.py <pid>
        Print argv to stdout, NUL-separated. Exit 0 on success, 1 on
        any read failure. Bash:
            ARGV="$(python3 argv.py "$pid" | tr '\\0' ' ')"

Stdlib-only (ctypes). No third-party deps.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import platform
import sys

CTL_KERN = 1
KERN_PROCARGS2 = 49

# Defensive upper bound on argc to reject corrupt buffers without iterating
# forever. Real-world git invocations are well below this.
_ARGC_MAX = 4096


def argv_bytes(pid: int) -> list[bytes] | None:
    """Return pid's argv as a list of byte-strings, or None on failure.

    None covers: non-Darwin platform, libc not loadable, sysctl error,
    malformed buffer. The caller leaves the SUBJECT cell empty rather than
    fall back to a mangling path.
    """
    if platform.system() != "Darwin":
        return None
    libc_path = ctypes.util.find_library("c")
    if not libc_path:
        return None
    try:
        libc = ctypes.CDLL(libc_path, use_errno=True)
    except OSError:
        return None

    libc.sysctl.argtypes = [
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_uint,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.c_void_p,
        ctypes.c_size_t,
    ]
    libc.sysctl.restype = ctypes.c_int

    mib = (ctypes.c_int * 3)(CTL_KERN, KERN_PROCARGS2, ctypes.c_int(pid))
    size = ctypes.c_size_t(0)
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
        return None
    if size.value < 4:
        return None
    buf = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
        return None
    data = buf.raw[: size.value]

    # KERN_PROCARGS2 layout (XNU sys/sysctl.h):
    #   int   argc;
    #   char  exec_path[];   NUL-terminated, then NUL padding to ptr align
    #   char  argv[0][];     NUL-terminated
    #   ...
    #   char  argv[argc-1][];
    #   char  envv[0][];     (ignored)
    argc = int.from_bytes(data[:4], sys.byteorder)
    if argc < 0 or argc > _ARGC_MAX:
        return None

    p = 4
    end = data.find(b"\x00", p)
    if end < 0:
        return None
    p = end
    while p < len(data) and data[p] == 0:
        p += 1

    args: list[bytes] = []
    for _ in range(argc):
        end = data.find(b"\x00", p)
        if end < 0:
            break
        args.append(data[p:end])
        p = end + 1
    return args


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: argv.py <pid>", file=sys.stderr)
        return 2
    try:
        pid = int(argv[0])
    except ValueError:
        return 2
    args = argv_bytes(pid)
    if args is None:
        return 1
    out = sys.stdout.buffer
    for i, a in enumerate(args):
        if i:
            out.write(b"\x00")
        out.write(a)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
