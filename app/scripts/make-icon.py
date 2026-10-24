"""生成应用图标（无第三方依赖）：圆角深色底 + 音频波形条。
输出 resources/icon.png (256) 与 resources/icon.ico（多尺寸，PNG 负载）。
形状覆盖率用解析式抗锯齿，不需要超采样，纯标准库即可。
"""
import struct
import zlib
import os
import math

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'resources')

BG_TOP = (28, 35, 52)
BG_BOT = (11, 14, 21)
GOLD = (242, 193, 78)
GOLD2 = (255, 227, 155)
CYAN = (125, 211, 252)


def lerp(a, b, t):
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def rr_cov(x, y, w, h, r, px=1.0):
    """点 (x,y) 在圆角矩形 (0,0,w,h) 内的覆盖率（0~1）；px = 一个像素的归一化宽度"""
    feather = 0.5 * px
    if x < -feather or y < -feather or x > w + feather or y > h + feather:
        return 0.0
    r = min(r, w / 2.0, h / 2.0)
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    d = math.hypot(x - cx, y - cy)
    if d <= r - feather:
        return 1.0
    if d >= r + feather:
        return 0.0
    return (r + feather - d) / (2 * feather)


def render(size):
    heights = [0.30, 0.52, 0.78, 0.52, 0.30]
    bar_w = 0.108
    gap = 0.052
    total_w = len(heights) * bar_w + (len(heights) - 1) * gap
    start_x = (1 - total_w) / 2.0
    px = 1.0 / size  # 一个像素在归一化坐标下的宽度

    rows = []
    for py in range(size):
        row = bytearray()
        v = (py + 0.5) * px
        for pxi in range(size):
            u = (pxi + 0.5) * px

            a = rr_cov(u, v, 1.0, 1.0, 0.22, px)
            if a <= 0.004:
                row += b'\x00\x00\x00\x00'
                continue

            bg = lerp(BG_TOP, BG_BOT, v * 0.95)
            glow = max(0.0, 1.0 - ((u - 0.5) ** 2) * 5.5 - ((v - 0.05) ** 2) * 5.0)
            bg = lerp(bg, (66, 92, 140), glow * 0.28)

            color = bg
            for i, h in enumerate(heights):
                bx = start_x + i * (bar_w + gap)
                by = (1 - h) / 2.0
                cov = rr_cov(u - bx, v - by, bar_w, h, bar_w / 2.0, px)
                if cov > 0.004:
                    t = (v - by) / h
                    bar = lerp(GOLD2, GOLD, t)
                    if i == 2:
                        bar = lerp(bar, CYAN, 0.34)
                    color = lerp(color, bar, cov)

            row += bytes([int(color[0]), int(color[1]), int(color[2]), int(round(255 * a))])
        rows.append(bytes(row))
    return b''.join(rows)


def png_bytes(size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag
            + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
        + chunk(b'IEND', b'')
    )


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    sizes = [256, 128, 64, 48, 32, 16]
    pngs = {}
    for s in sizes:
        pngs[s] = png_bytes(s, render(s))
        print(f'rendered {s}x{s} ({len(pngs[s])} bytes)')

    with open(os.path.join(OUT_DIR, 'icon.png'), 'wb') as f:
        f.write(pngs[256])

    count = len(sizes)
    header = struct.pack('<HHH', 0, 1, count)
    offset = 6 + 16 * count
    entries = b''
    payload = b''
    for s in sizes:
        w = 0 if s >= 256 else s
        data = pngs[s]
        entries += struct.pack('<BBBBHHII', w, w, 0, 0, 1, 32, len(data), offset + len(payload))
        payload += data
    with open(os.path.join(OUT_DIR, 'icon.ico'), 'wb') as f:
        f.write(header + entries + payload)
    print('wrote icon.png / icon.ico ->', OUT_DIR)


if __name__ == '__main__':
    main()
