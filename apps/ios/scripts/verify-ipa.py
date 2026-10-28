#!/usr/bin/env python3
"""Inspect Capri's real IPA bytes, optionally extract a safe signing workspace.

This validates embedded XML entitlements, not cryptographic code signatures.
The macOS packaging script additionally runs codesign --verify --strict.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import struct
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def embedded_entitlements(data):
    require(len(data) >= 32, 'Truncated Mach-O header')
    magic, cpu, _, _, commands, command_bytes, _, _ = struct.unpack_from('<8I', data)
    require(magic == 0xFEEDFACF and cpu == 0x0100000C, 'Expected a thin arm64 iPhone executable')
    end = 32 + command_bytes
    require(end <= len(data) and commands <= 4096 and command_bytes <= 1024 * 1024
            and commands <= command_bytes // 8, 'Invalid Mach-O command table')
    position = 32
    signatures = []
    for _ in range(commands):
        require(position + 8 <= end, 'Truncated Mach-O command')
        command, size = struct.unpack_from('<II', data, position)
        require(size >= 8 and size % 8 == 0 and position + size <= end, 'Invalid Mach-O command size')
        if command == 0x1D:  # LC_CODE_SIGNATURE
            require(size == 16, 'Invalid LC_CODE_SIGNATURE')
            signatures.append(struct.unpack_from('<II', data, position + 8))
        position += size
    require(position == end, 'Mach-O command bytes do not match the header')
    require(len(signatures) == 1, 'Expected one embedded LC_CODE_SIGNATURE')
    offset, length = signatures[0]
    require(offset >= end and 12 <= length <= 4 * 1024 * 1024 and offset + length <= len(data), 'Invalid embedded signature bounds')
    signature = data[offset:offset + length]
    magic, total, slots = struct.unpack_from('>III', signature)
    require(magic == 0xFADE0CC0 and 12 <= total <= length and slots <= min(128, (total - 12) // 8), 'Invalid code signature SuperBlob')
    entitlements = []
    ranges = []
    for index in range(slots):
        kind, start = struct.unpack_from('>II', signature, 12 + index * 8)
        require(start >= 12 + slots * 8 and start + 8 <= total, 'Invalid signature slot')
        blob_magic, blob_size = struct.unpack_from('>II', signature, start)
        require(blob_size >= 8 and start + blob_size <= total, 'Invalid signature blob bounds')
        require(all(start + blob_size <= low or start >= high for low, high in ranges), 'Overlapping signature blobs')
        ranges.append((start, start + blob_size))
        if kind == 5:  # CSSLOT_ENTITLEMENTS; SideStore reads this XML blob.
            require(blob_magic == 0xFADE7171 and blob_size <= 1024 * 1024, 'Invalid XML entitlements magic or size')
            entitlements.append(plistlib.loads(signature[start + 8:start + blob_size].rstrip(b'\0')))
    require(len(entitlements) == 1 and isinstance(entitlements[0], dict), 'Expected one embedded XML entitlement dictionary')
    return entitlements[0]


def inspect(path, group, sealed=False, extract=None, personal_art_sha256=None, live_activity=False):
    require(re.fullmatch(r'group\.[A-Za-z0-9.-]{3,200}', group), 'Invalid expected App Group')
    with zipfile.ZipFile(path) as archive:
        require(archive.testzip() is None, 'IPA has a corrupt entry')
        names = archive.namelist()
        require(len(names) == len(set(names)), 'IPA contains duplicate paths')
        for item in archive.infolist():
            name = item.filename
            parts = PurePosixPath(name).parts
            require(name and not name.startswith('/') and '\\' not in name and '..' not in parts,
                    'IPA contains an unsafe extraction path')
            require(not stat.S_ISLNK(item.external_attr >> 16), 'IPA contains an unsupported symbolic link')
        app_plists = [name for name in names if name.startswith('Payload/') and name.count('/') == 2 and name.endswith('.app/Info.plist')]
        require(len(app_plists) == 1, 'IPA must contain one application')
        app = app_plists[0].rsplit('/', 1)[0]
        extensions = [name for name in names if name.endswith('.appex/Info.plist')]
        require(len(extensions) == (2 if live_activity else 1) and all(name.startswith(app + '/PlugIns/') for name in extensions), 'IPA must embed the expected extensions' if live_activity else 'IPA must embed one Share Extension')
        shares = [name for name in extensions if name.endswith('/CapriShare.appex/Info.plist')]
        widgets = [name for name in extensions if name.endswith('/CapriLive.appex/Info.plist')]
        require(len(shares) == 1 and len(widgets) == (1 if live_activity else 0), 'IPA has unexpected extension identities')
        extension = shares[0].rsplit('/', 1)[0]
        info, extension_info = (plistlib.loads(archive.read(name)) for name in (app_plists[0], shares[0]))
        require(info.get('CFBundleIdentifier') == 'dev.gentledot.capri' and info.get('DTPlatformName') == 'iphoneos', 'IPA is not the Capri device app')
        require(bool(info.get('NSMicrophoneUsageDescription')), 'IPA is missing its microphone purpose')
        require(extension_info.get('CFBundleIdentifier') == 'dev.gentledot.capri.share'
                and extension_info.get('DTPlatformName') == 'iphoneos'
                and extension_info.get('NSExtension', {}).get('NSExtensionPointIdentifier') == 'com.apple.share-services', 'IPA has an invalid Share Extension')
        result = {'app': app, 'extension': extension, 'group': group}
        if live_activity:
            widget = widgets[0].rsplit('/', 1)[0]
            widget_info = plistlib.loads(archive.read(widgets[0]))
            require(info.get('NSSupportsLiveActivities') is True and widget_info.get('CFBundleIdentifier') == 'dev.gentledot.capri.live'
                    and widget_info.get('DTPlatformName') == 'iphoneos' and widget_info.get('NSExtension', {}).get('NSExtensionPointIdentifier') == 'com.apple.widgetkit-extension', 'IPA has an invalid Live Activity extension')
            executable = widget_info.get('CFBundleExecutable', '')
            require(isinstance(executable, str) and executable and '/' not in executable and '\\' not in executable and executable not in ('.', '..'), 'Invalid widget executable')
            member = widget + '/' + executable
            binary = archive.read(member)
            require(len(binary) >= 32 and struct.unpack_from('<II', binary) == (0xFEEDFACF, 0x0100000C), 'Expected an arm64 iPhone widget executable')
            if sealed:
                require(embedded_entitlements(binary) == {}, 'Unexpected Live Activity entitlements')
            result['widget'], result['widgetExecutable'] = widget, member
        if personal_art_sha256 is not None:
            require(re.fullmatch(r'[a-f0-9]{64}', personal_art_sha256), 'Invalid expected personal artwork fingerprint')
            prefix = app + '/personal-art/'
            require(archive.getinfo(prefix + 'manifest.json').file_size <= 2048, 'Oversized personal artwork manifest')
            require(57 <= archive.getinfo(prefix + 'capri-full.png').file_size <= 5 * 1024 * 1024, 'Oversized or empty personal PNG')
            artwork = archive.read(prefix + 'capri-full.png')
            art_manifest = json.loads(archive.read(prefix + 'manifest.json'))
            require(art_manifest == {'schemaVersion': 1, 'file': 'capri-full.png', 'sha256': personal_art_sha256,
                                    'size': len(artwork), 'width': 240, 'height': 420}, 'Personal artwork manifest mismatch')
            require(hashlib.sha256(artwork).hexdigest() == personal_art_sha256, 'Personal artwork SHA-256 mismatch')
            require(artwork[:8] == b'\x89PNG\r\n\x1a\n' and artwork[8:16] == b'\x00\x00\x00\rIHDR'
                    and struct.unpack_from('>II', artwork, 16) == (240, 420), 'Personal Capri is not the expected 240x420 PNG')
            result['personalArtworkSHA256'] = personal_art_sha256
            if live_activity:
                widget_prefix = widget + '/personal-art/'
                require(archive.getinfo(widget_prefix + 'manifest.json').file_size <= 2048
                        and 57 <= archive.getinfo(widget_prefix + 'capri-full.png').file_size <= 5 * 1024 * 1024,
                        'Invalid widget artwork size')
                widget_artwork = archive.read(widget_prefix + 'capri-full.png')
                widget_manifest = json.loads(archive.read(widget_prefix + 'manifest.json'))
                require(widget_manifest == art_manifest and widget_artwork == artwork
                        and hashlib.sha256(widget_artwork).hexdigest() == personal_art_sha256,
                        'Widget personal artwork does not match the verified original')
                result['widgetPersonalArtworkSHA256'] = personal_art_sha256
        elif live_activity:
            require(not any(name.startswith(widget + '/personal-art/') for name in names),
                    'Generic widget unexpectedly contains personal artwork')
        for label, directory, plist in [('app', app, info), ('extension', extension, extension_info)]:
            executable = plist.get('CFBundleExecutable', '')
            require(isinstance(executable, str) and executable and '/' not in executable and '\\' not in executable and executable not in ('.', '..'), 'IPA has an invalid executable name')
            require(plist.get('CapriAppGroup') == group, f'{label} Info.plist has an unexpected App Group')
            member = directory + '/' + executable
            binary = archive.read(member)
            require(len(binary) >= 32 and struct.unpack_from('<II', binary) == (0xFEEDFACF, 0x0100000C), f'Expected an arm64 iPhone {label} executable')
            if sealed:
                groups = embedded_entitlements(binary).get('com.apple.security.application-groups')
                require(groups == [group], f'{label} embedded App Group entitlements do not match the configured group')
            result[label + 'Executable'] = member
        if extract:
            extract = Path(extract).resolve()
            require(not extract.exists(), 'Signing workspace must not already exist')
            extract.mkdir(parents=True)
            for item in archive.infolist():
                target = extract.joinpath(*PurePosixPath(item.filename).parts)
                require(target.is_relative_to(extract), 'IPA extraction escaped the workspace')
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(item))
                    os.chmod(target, (item.external_attr >> 16) & 0o777 or 0o644)
        return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa')
    parser.add_argument('--group', default='group.dev.gentledot.capri')
    parser.add_argument('--sealed', action='store_true')
    parser.add_argument('--live-activity', action='store_true')
    parser.add_argument('--extract')
    parser.add_argument('--manifest')
    parser.add_argument('--personal-art-sha256')
    arguments = parser.parse_args()
    try:
        result = inspect(arguments.ipa, arguments.group, arguments.sealed, arguments.extract, arguments.personal_art_sha256, arguments.live_activity)
        if arguments.manifest:
            Path(arguments.manifest).write_text(json.dumps(result))
        print(json.dumps(result))
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, plistlib.InvalidFileException, struct.error) as error:
        raise SystemExit(f'IPA verification failed: {error}')
