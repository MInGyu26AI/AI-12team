"""The single entry point of the packaged Windows app, syncup.exe (built by windows_bundle.py).

    syncup.exe run ...           app.py run: the review page and collection (README)
    syncup.exe native-setup ...  prepare_native.py: the Chrome native host launcher and manifest
    syncup.exe native-host ...   native_host.py, which Chrome starts through that launcher

runtime.script_command maps each script to these subcommands, so a launcher starts them the same way from source.
"""
import sys

USAGE = ('사용법: syncup.exe run --project <프로젝트 폴더> --state <상태 폴더> --team-api <팀 서버 주소> '
         '--team-token-file <연결 키 파일> [옵션]  또는  syncup.exe native-setup ... (docs/windows.md)')


def main():
    # Text sent to a pipe or file uses the console's code page by default, which cannot hold Korean on English
    # Windows; the console itself is written in Unicode either way.
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and not stream.isatty():
            stream.reconfigure(encoding='utf-8', errors='backslashreplace')
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command == 'run':
        import app
        app.main()
    elif command == 'native-host':
        del sys.argv[1]
        import native_host
        native_host.main()
    elif command == 'native-setup':
        del sys.argv[1]
        import prepare_native
        prepare_native.main()
    else:
        raise SystemExit(USAGE)


if __name__ == '__main__':
    main()
