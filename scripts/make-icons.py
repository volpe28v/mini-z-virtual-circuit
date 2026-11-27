#!/usr/bin/env python3
"""アイコン (PNG) を標準ライブラリだけで生成する。使い方: python3 scripts/make-icons.py"""
import math
import struct
import sys
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def pixel(u, v):
    """u, v は -1..1。コースのリングを描く。"""
    ang = math.radians(-18)
    x = u * math.cos(ang) - v * math.sin(ang)
    y = u * math.sin(ang) + v * math.cos(ang)
    n = 3.0
    r = (abs(x / 0.92) ** n + abs(y / 0.62) ** n) ** (1 / n)
    th = math.atan2(y, x)
    stripe = int((th + math.pi) / (2 * math.pi) * 28) % 2
    grass = (38, 74, 32)
    if r < 0.50:
        return (30, 58, 26)
    if r < 0.58 or 0.86 <= r < 0.95:
        return (200, 36, 40) if stripe else (236, 233, 226)
    if 0.58 <= r < 0.86:
        base = (62, 64, 70)
        if abs(r - 0.72) < 0.008 and int((th + math.pi) / (2 * math.pi) * 60) % 2:
            return (230, 230, 225)
        # ドリフト痕
        if abs(math.hypot(x - 0.55, y + 0.1) - 0.5) < 0.012 and x > 0.3:
            return (24, 24, 26)
        return base
    return grass


def render(size, ss=2):
    rows = []
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            acc = [0, 0, 0]
            for sj in range(ss):
                for si in range(ss):
                    u = ((i + (si + 0.5) / ss) / size) * 2 - 1
                    v = ((j + (sj + 0.5) / ss) / size) * 2 - 1
                    p = pixel(u, v)
                    for k in range(3):
                        acc[k] += p[k]
            row += bytes(c // (ss * ss) for c in acc)
        rows.append(bytes(row))
    return b"".join(rows)


def png(size):
    raw = render(size)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    OUT.mkdir(exist_ok=True)
    for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
        (OUT / name).write_bytes(png(size))
        print("wrote", OUT / name)


if __name__ == "__main__":
    sys.exit(main())
