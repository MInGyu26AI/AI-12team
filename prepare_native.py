"""Generate an exact-origin Chrome host manifest; does not register it globally."""
import argparse
import json
from pathlib import Path
import shlex
import sys

from native_host import EXTENSION_ID
from runtime import ENABLED_PLATFORMS

HOST_NAME = 'com.syncup.collector'


def prepare(extension_id, connection, output):
    if not EXTENSION_ID.fullmatch(extension_id):
        raise ValueError('Chrome 확장 프로그램 ID는 a~p 소문자 32자입니다.')
    if sys.platform not in ENABLED_PLATFORMS:
        raise ValueError('현재 활성 연결은 macOS입니다.')
    output.mkdir(parents=True, exist_ok=True)
    launcher = output / 'syncup-native'
    command = [sys.executable, str(Path(__file__).with_name('native_host.py').resolve()),
               '--connection', str(connection.resolve()), '--extension-id', extension_id]
    with launcher.open('x') as f:
        f.write('#!/bin/sh\nexec ' + shlex.join(command) + ' "$@"\n')
    launcher.chmod(0o700)
    manifest = output / f'{HOST_NAME}.json'
    with manifest.open('x') as f:
        json.dump(dict(name=HOST_NAME, description='SyncUp local approval service', path=str(launcher.resolve()),
                       type='stdio', allowed_origins=[f'chrome-extension://{extension_id}/']), f, indent=2)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extension-id', required=True)
    parser.add_argument('--connection', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(prepare(args.extension_id, args.connection, args.output))
