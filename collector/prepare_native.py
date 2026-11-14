"""Generate an exact-origin Chrome host manifest and its launcher; does not register them with Chrome.

Registration is per user and left to the user (docs/running.md, docs/windows.md): on macOS, copy the manifest into
Chrome's NativeMessagingHosts folder; on Windows, run the registry command `registration_command` gives.
"""
import sys
from pathlib import Path

# 폴더별로 실행해도 contract/ 의 공용 모듈과 저장소 루트의 ai/ 를 찾는다
_REPO = Path(__file__).resolve().parents[1]
sys.path[1:1] = [str(_REPO / 'contract'), str(_REPO)]

import argparse
import json
import os
from pathlib import Path
import shlex
import sys

from native_host import EXTENSION_ID
from private_files import make_private_directory
from runtime import ENABLED_PLATFORMS, script_command

HOST_NAME = 'com.syncup.collector'
WINDOWS_REGISTRY_KEY = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME
# cmd.exe reads a batch file in the console code page, which is the OEM code page in the console Chrome starts.
CMD_ENCODING = 'oem'


def _posix_launcher(output, command):
    launcher = output / 'syncup-native'
    with launcher.open('x') as f:
        f.write('#!/bin/sh\nexec ' + shlex.join(command) + ' "$@"\n')
    launcher.chmod(0o700)
    return launcher


def cmd_argument(value, profile):
    """value as one double-quoted argument in a batch file.

    % is doubled because a batch file expands it even inside quotes. A path in the user profile starts with
    %USERPROFILE%, so a non-ASCII user name is expanded by cmd.exe instead of passing through the code page.
    """
    if any(c in value for c in '"\r\n'):
        raise ValueError('경로에 큰따옴표나 줄바꿈이 있으면 연결을 만들 수 없습니다.')
    if profile and value.lower().startswith(profile.lower() + '\\'):  # Windows paths ignore case
        return '"%USERPROFILE%' + value[len(profile):].replace('%', '%%') + '"'
    return '"' + value.replace('%', '%%') + '"'


def _windows_launcher(output, command):
    """A .cmd file: Chrome on Windows starts the host through cmd.exe and cannot pass it arguments of ours."""
    profile = os.environ.get('USERPROFILE', '').rstrip('\\')
    line = ' '.join(cmd_argument(part, profile) for part in command) + ' %*'
    head = '@echo off\r\nsetlocal DisableDelayedExpansion\r\n'
    try:
        data = (head + line + '\r\n').encode(CMD_ENCODING)
    except UnicodeEncodeError:
        # A path the code page cannot hold, such as a Korean folder on English Windows: cmd.exe reads each line just
        # before running it, so after chcp 65001 the command line is read as UTF-8.
        data = (head + 'chcp 65001 >nul\r\n' + line + '\r\n').encode('utf-8')
    launcher = output / 'syncup-native.cmd'
    with launcher.open('xb') as f:
        f.write(data)
    return launcher


def prepare(extension_id, connection, output):
    if not EXTENSION_ID.fullmatch(extension_id):
        raise ValueError('Chrome 확장 프로그램 ID는 a~p 소문자 32자입니다.')
    if sys.platform not in ENABLED_PLATFORMS:
        raise ValueError('이 운영체제에서는 아직 연결을 지원하지 않습니다 (macOS·Windows).')
    # Chrome runs the launcher as this user, so on Windows no other account may replace it or the manifest.
    make_private_directory(output)
    command = script_command('native_host.py', '--connection', str(connection.resolve()), '--extension-id', extension_id)
    launcher = (_windows_launcher if sys.platform == 'win32' else _posix_launcher)(output, command)
    manifest = output / f'{HOST_NAME}.json'
    with manifest.open('x') as f:
        json.dump(dict(name=HOST_NAME, description='SyncUp local approval service', path=str(launcher.resolve()),
                       type='stdio', allowed_origins=[f'chrome-extension://{extension_id}/']), f, indent=2)
    return manifest


def registration_command(manifest):
    """The command that registers the manifest with Chrome on Windows, for the current user only."""
    return f'reg add "{WINDOWS_REGISTRY_KEY}" /ve /t REG_SZ /d "{manifest.resolve()}" /f'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extension-id', required=True)
    parser.add_argument('--connection', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    manifest = prepare(args.extension_id, args.connection, args.output)
    print(manifest)
    if sys.platform == 'win32':
        print('Chrome에 등록하려면 다음 명령을 실행하세요:')
        print(registration_command(manifest))


if __name__ == '__main__':
    main()
