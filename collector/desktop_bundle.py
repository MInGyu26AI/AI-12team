"""Build a desktop setup app on the target OS; no secrets are accepted or bundled.

python collector/desktop_bundle.py --web-url https://...vercel.app --team-api https://... --version <commit>
Requires Python 3.12, desktop-requirements.txt and the matching release scanner in bin/.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys

import desktop_setup

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--web-url', required=True)
    parser.add_argument('--team-api', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--local-demo', action='store_true', help='Explicit loopback-only demo; separate PC state')
    args = parser.parse_args()
    if sys.platform not in ('darwin', 'win32'):
        parser.error('Mac 또는 Windows에서 빌드하세요.')
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', args.version):
        parser.error('버전 형식을 확인하세요.')
    scanner = 'syncup-scanner.exe' if sys.platform == 'win32' else 'syncup-scanner'
    if not (ROOT / 'bin' / scanner).is_file():
        parser.error('해당 운영체제의 release 스캐너를 bin/에 먼저 빌드하세요.')
    work = ROOT / 'build/desktop'
    work.mkdir(parents=True, exist_ok=True)
    config = work / 'desktop-config.json'
    config.write_text(json.dumps(dict(web_url=args.web_url, team_api=args.team_api, version=args.version,
                                     local_demo=args.local_demo)), encoding='utf-8')
    desktop_setup.read_config(work)
    import certifi
    data = [(Path(certifi.where()), 'certs'),
            (ROOT/'bin'/scanner, 'bin'), (ROOT/'ai/prompts', 'ai/prompts'),
            (ROOT/'web/public/syncup-extension.zip', '.'), (config, '.'),
            (ROOT/'collector/desktop.html', '.'), (ROOT/'collector/desktop.js', '.'),
            (ROOT/'collector/desktop-assets', 'desktop-assets')]
    import PyInstaller.__main__
    # Windows windowed bootloaders discard stdin/stdout, which Chrome native messaging requires.
    PyInstaller.__main__.run(['--noconfirm', '--clean', '--onedir',
        '--console' if sys.platform == 'win32' else '--windowed', '--name', 'SyncUp',
        '--distpath', str(ROOT/'dist/desktop'), '--workpath', str(work/'pyinstaller'), '--specpath', str(work),
        *(['--osx-entitlements-file', str(ROOT/'collector/desktop-macos-entitlements.plist')]
          if sys.platform == 'darwin' else []),
        *(f'--paths={ROOT / p}' for p in ('collector', 'contract', '.')),
        *(f'--add-data={src}{os.pathsep}{dest}' for src, dest in data), '--exclude-module=psycopg',
        str(ROOT/'collector/desktop_entry.py')])


if __name__ == '__main__':
    main()
