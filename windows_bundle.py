"""Build the packaged Windows app, dist/syncup/syncup.exe, so that Windows users need no Python or Rust.

On Windows, from the repository root, with bin/syncup-collector.exe built and PyInstaller installed:

    python windows_bundle.py

The result is a folder: syncup.exe and the _internal folder it runs from, kept together. A folder rather than one
self-extracting file because Chrome starts the native host anew for every request, and a single file would unpack
itself each time. .github/workflows/windows.yml builds it and checks it with check_windows_bundle.py.
"""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
NAME = 'syncup'
BUNDLE = ROOT / 'dist' / NAME
# Files the app reads at run time, as (source, folder in the bundle); code finds them next to its own modules.
DATA = [
    ('bin/syncup-collector.exe', 'bin'),  # runtime.collector_binary
    ('ai/prompts', 'ai/prompts'),  # ai.syncup_ai.config.PROMPTS
]
# Used only by the team server, not by the local app.
EXCLUDED = ['psycopg', 'team_server', 'cloud_server', 'conflict_checks', 'conflict_scheduler']


def pyinstaller_arguments():
    missing = [source for source, _ in DATA if not (ROOT / source).exists()]
    if missing:
        raise SystemExit('먼저 만들어야 하는 파일: ' + ', '.join(missing))
    build = ROOT / 'build' / 'pyinstaller'
    return ['--noconfirm', '--clean', '--onedir', '--console', '--name', NAME,
            '--distpath', str(BUNDLE.parent), '--workpath', str(build), '--specpath', str(build),
            *(f'--add-data={ROOT / source}{os.pathsep}{folder}' for source, folder in DATA),
            *(f'--exclude-module={module}' for module in EXCLUDED),
            str(ROOT / 'syncup_entry.py')]


def main():
    if sys.platform != 'win32':
        raise SystemExit('Windows에서 실행하세요: 묶음에는 그 OS의 Python과 실행 파일이 들어갑니다.')
    import PyInstaller.__main__
    PyInstaller.__main__.run(pyinstaller_arguments())
    print(BUNDLE / f'{NAME}.exe')


if __name__ == '__main__':
    main()
