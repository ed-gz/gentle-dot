#!/usr/bin/env python3
"""Check an unsigned iOS archive's targets; do not sign, package or export it."""
import argparse
from pathlib import Path
import plistlib
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def info(bundle, identifier):
    with (bundle / 'Info.plist').open('rb') as source:
        value = plistlib.load(source)
    require(value.get('CFBundleIdentifier') == identifier, f'Unexpected bundle identifier for {bundle.name}')
    require(value.get('DTPlatformName') == 'iphoneos', f'{bundle.name} is not an iPhone device target')
    name = value.get('CFBundleExecutable')
    require(isinstance(name, str) and name and Path(name).name == name and name not in ('.', '..'), 'Invalid executable name')
    executable = bundle / name
    require(executable.is_file() and not executable.is_symlink(), f'Missing executable for {bundle.name}')
    arch = subprocess.check_output(['xcrun', 'lipo', '-archs', str(executable)], text=True).split()
    require('arm64' in arch, f'{bundle.name} does not contain arm64')
    return value, executable


def linked(executable, frameworks):
    output = subprocess.check_output(['xcrun', 'otool', '-L', str(executable)], text=True)
    for framework in frameworks:
        require(f'{framework}.framework/' in output, f'Missing {framework} link in {executable.name}')


def inspect(archive, group):
    require(archive.is_dir() and archive.suffix == '.xcarchive' and not archive.is_symlink(), 'Missing iOS archive')
    apps = list((archive / 'Products' / 'Applications').glob('*.app'))
    require(len(apps) == 1 and not apps[0].is_symlink(), 'Expected exactly one archived app')
    app = apps[0]
    main, main_bin = info(app, 'dev.gentledot.capri')
    require(main.get('CapriAppGroup') == group, 'App Group configuration does not match')
    require(bool(main.get('NSMicrophoneUsageDescription')) and bool(main.get('NSCameraUsageDescription')), 'Missing microphone or camera purpose')
    require(main.get('NSSupportsLiveActivities') is True, 'Missing Live Activity configuration')
    plugins = app / 'PlugIns'
    extensions = list(plugins.glob('*.appex'))
    require({item.name for item in extensions} == {'CapriShare.appex', 'CapriLive.appex'} and len(extensions) == 2,
            'Expected Share and Live Activity extensions')
    share, share_bin = info(plugins / 'CapriShare.appex', 'dev.gentledot.capri.share')
    widget, widget_bin = info(plugins / 'CapriLive.appex', 'dev.gentledot.capri.live')
    require(share.get('CapriAppGroup') == group, 'Share App Group configuration does not match')
    require(share.get('NSExtension', {}).get('NSExtensionPointIdentifier') == 'com.apple.share-services', 'Invalid Share target')
    require(widget.get('NSExtension', {}).get('NSExtensionPointIdentifier') == 'com.apple.widgetkit-extension', 'Invalid Live Activity target')
    linked(main_bin, ['FoundationModels', 'Speech', 'Vision'])
    linked(widget_bin, ['ActivityKit', 'WidgetKit'])
    # Unsigned archives cannot prove entitlements, SideStore signing or device behavior.
    return (main_bin, share_bin, widget_bin)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('--group', default='group.dev.gentledot.capri')
    args = parser.parse_args()
    try:
        inspect(args.archive, args.group)
        print('Unsigned iOS archive: app, Share and Live Activity targets verified (arm64 and framework links).')
    except (OSError, ValueError, plistlib.InvalidFileException, subprocess.CalledProcessError) as error:
        print(f'Archive preflight failed: {error}', file=sys.stderr)
        sys.exit(1)
