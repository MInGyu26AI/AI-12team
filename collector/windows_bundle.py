"""Build the packaged Windows app, dist/syncup/syncup.exe, so that Windows users need no Python or Rust.

On Windows, from the repository root, with bin/syncup-scanner.exe built and PyInstaller installed:

    python collector/windows_bundle.py

The result is a folder: syncup.exe and the _internal folder it runs from, kept together. A folder rather than one
self-extracting file because Chrome starts the native host anew for every request, and a single file would unpack
itself each time. .github/workflows/windows.yml builds it and checks it with checks/check_windows_bundle.py.
"""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
NAME = 'syncup'
BUNDLE = ROOT / 'dist' / NAME
# Files the app reads at run time, as (source, folder in the bundle); code finds them next to its own modules.
DATA = [
    ('bin/syncup-scanner.exe', 'bin'),  # runtime.scanner_binary
    ('ai/prompts', 'ai/prompts'),  # ai.syncup_ai.config.PROMPTS
]
# The local app's modules live in collector/, contract/ and ai/ (repository root); server/ is not packaged.
SEARCH_PATHS = ['collector', 'contract', '.']
# The team server's database driver, which the local app never imports.
EXCLUDED = ['psycopg']


def pyinstaller_arguments():
    missing = [source for source, _ in DATA if not (ROOT / source).exists()]
    if missing:
        raise SystemExit('먼저 만들어야 하는 파일: ' + ', '.join(missing))
    build = ROOT / 'build' / 'pyinstaller'
    return ['--noconfirm', '--clean', '--onedir', '--console', '--name', NAME,
            '--distpath', str(BUNDLE.parent), '--workpath', str(build), '--specpath', str(build),
            *(f'--paths={ROOT / folder}' for folder in SEARCH_PATHS),
            *(f'--add-data={ROOT / source}{os.pathsep}{folder}' for source, folder in DATA),
            *(f'--exclude-module={module}' for module in EXCLUDED),
            str(ROOT / 'collector' / 'syncup_entry.py')]


def main():
    if sys.platform != 'win32':
        raise SystemExit('Windows에서 실행하세요: 묶음에는 그 OS의 Python과 실행 파일이 들어갑니다.')
    import PyInstaller.__main__
    PyInstaller.__main__.run(pyinstaller_arguments())
    print(BUNDLE / f'{NAME}.exe')


if __name__ == '__main__':
    main()
