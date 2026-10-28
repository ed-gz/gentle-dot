#!/usr/bin/env python3
"""Compare the actual iPhone icon in an IPA to the generated Xcode asset.

Xcode may optimize the packaged PNG as CgBI (BGRA and raw DEFLATE), so its
compressed bytes are not expected to match the source PNG. Decode both without
external packages and compare opaque pixels instead of comparing filenames.
"""
import struct
import sys
import zlib
import zipfile
from pathlib import Path


def pixels(data):
    if len(data) > 4 * 1024 * 1024 or not data.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('Invalid icon PNG')
    pos, chunks, apple, header, ended = 8, [], False, None, False
    while pos + 12 <= len(data):
        size = struct.unpack_from('>I', data, pos)[0]
        end = pos + size + 12
        if end > len(data):
            raise ValueError('Truncated icon PNG')
        kind, payload = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + size]
        crc = struct.unpack_from('>I', data, pos + 8 + size)[0]
        if zlib.crc32(kind + payload) & 0xffffffff != crc:
            raise ValueError('Invalid icon PNG checksum')
        if kind == b'CgBI': apple = True
        if kind == b'IHDR': header = payload
        if kind == b'IDAT': chunks.append(payload)
        if kind == b'IEND': ended = True; break
        pos = end
    if not ended or not header or len(header) != 13:
        raise ValueError('Missing icon PNG header or end')
    width, height, depth, color, compression, filt, interlace = struct.unpack('>IIBBBBB', header)
    if (width, height, depth, color, compression, filt, interlace) != (120, 120, 8, 6, 0, 0, 0):
        raise ValueError('Expected a non-interlaced 120×120 RGBA icon')
    decompressor = zlib.decompressobj(-15 if apple else 15)
    raw = decompressor.decompress(b''.join(chunks), 120 * 481 + 1)
    if len(raw) != 120 * 481 or not decompressor.eof:
        raise ValueError('Invalid icon pixel data')
    previous = bytearray(480)
    output = bytearray()
    for y in range(120):
        row = bytearray(raw[y * 481 + 1:(y + 1) * 481])
        method = raw[y * 481]
        if method > 4: raise ValueError('Unsupported icon PNG filter')
        for x in range(480):
            a = row[x - 4] if x >= 4 else 0
            b = previous[x]
            c = previous[x - 4] if x >= 4 else 0
            if method == 1: predictor = a
            elif method == 2: predictor = b
            elif method == 3: predictor = (a + b) // 2
            elif method == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                predictor = a if pa <= pb and pa <= pc else b if pb <= pc else c
            else: predictor = 0
            row[x] = (row[x] + predictor) & 255
        for x in range(0, 480, 4):
            if row[x + 3] != 255: raise ValueError('iPhone app icon must be opaque')
            output.extend((row[x + 2], row[x + 1], row[x], 255) if apple else row[x:x + 4])
        previous = row
    return bytes(output)


def verify(ipa, expected):
    with zipfile.ZipFile(ipa) as archive:
        names = [name for name in archive.namelist() if name.startswith('Payload/')
                 and name.count('/') == 2 and name.endswith('.app/AppIcon60x60@2x.png')]
        if len(names) != 1: raise ValueError('Expected one packaged iPhone app icon')
        if pixels(archive.read(names[0])) != pixels(Path(expected).read_bytes()):
            raise ValueError('Packaged iPhone icon does not match the generated asset')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3: raise ValueError('Usage: verify-app-icon.py IPA EXPECTED.png')
        verify(sys.argv[1], sys.argv[2])
        print('Packaged iPhone app icon matches generated pixels.')
    except (ValueError, OSError, zipfile.BadZipFile, zlib.error, struct.error) as error:
        raise SystemExit(f'IPA icon verification failed: {error}')
