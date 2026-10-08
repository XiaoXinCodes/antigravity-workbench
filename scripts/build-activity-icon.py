"""Trace the approved brand PNG alpha into a monochrome activity-bar SVG.

Python standard library only. Run after build-brand-assets.ps1. The vector
keeps the A, orbit and base; VS Code supplies its theme color through a mask.
"""
import math
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
data = (ROOT / 'media/brand-logo.png').read_bytes()
assert data[:8] == b'\x89PNG\r\n\x1a\n'
offset, payload = 8, bytearray()
while offset < len(data):
    length = int.from_bytes(data[offset:offset + 4], 'big')
    kind = data[offset + 4:offset + 8]
    chunk = data[offset + 8:offset + 8 + length]
    if kind == b'IHDR':
        width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', chunk)
        assert (width, height, depth, color, compression, filtering, interlace) == (512, 512, 8, 6, 0, 0, 0)
    elif kind == b'IDAT':
        payload.extend(chunk)
    offset += length + 12
raw = zlib.decompress(payload)
rows, previous, stride = [], bytearray(width * 4), width * 4
for y in range(height):
    start = y * (stride + 1)
    mode, row = raw[start], bytearray(raw[start + 1:start + 1 + stride])
    for x in range(stride):
        left, up, corner = row[x - 4] if x >= 4 else 0, previous[x], previous[x - 4] if x >= 4 else 0
        p = left + up - corner
        predictor = min((left, up, corner), key=lambda c: abs(p - c))
        row[x] = (row[x] + (0, left, up, (left + up) // 2, predictor)[mode]) & 255
    rows.append(row)
    previous = row
pixels = {(x, y) for y, row in enumerate(rows) for x in range(width) if row[x * 4 + 3] >= 128}
edges = {}
for x, y in sorted(pixels, key=lambda p: (p[1], p[0])):
    for neighbor, first, last in (
        ((x, y-1), (x, y), (x+1, y)), ((x+1, y), (x+1, y), (x+1, y+1)),
        ((x, y+1), (x+1, y+1), (x, y+1)), ((x-1, y), (x, y+1), (x, y))):
        if neighbor not in pixels:
            edges.setdefault(first, []).append(last)


def simplify(points, tolerance=1.25):
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    dx, dy = b[0]-a[0], b[1]-a[1]
    norm = math.hypot(dx, dy)
    distances = [abs(dy*p[0]-dx*p[1]+b[0]*a[1]-b[1]*a[0])/norm if norm else math.dist(a,p) for p in points]
    index = max(range(len(points)), key=distances.__getitem__)
    return simplify(points[:index+1], tolerance)[:-1] + simplify(points[index:], tolerance) if distances[index] > tolerance else [a,b]


paths = []
while edges:
    start = next(iter(edges))
    points, current = [start], start
    while True:
        target = edges[current].pop()
        if not edges[current]:
            del edges[current]
        points.append(target)
        current = target
        if current == start:
            break
    area = abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points, points[1:]))) / 2
    if area < 8:
        continue
    middle = len(points)//2
    points = simplify(points[:middle+1])[:-1] + simplify(points[middle:])
    coordinates = [f'{x*24/width:.3f} {y*24/height:.3f}' for x,y in points[:-1]]
    paths.append('M'+'L'.join(coordinates)+'Z')
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">\n  <path fill="currentColor" fill-rule="evenodd" d="' + ''.join(paths) + '"/>\n</svg>\n'
(ROOT / 'media/workbench.svg').write_text(svg, encoding='utf-8')
print(f'Wrote monochrome A / orbit / base: {len(paths)} contours, {len(svg)} bytes')
