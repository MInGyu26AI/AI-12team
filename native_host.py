"""Chrome Native Messaging transport; the running local service owns all state."""
import argparse
import json
import os
from pathlib import Path
import re
import struct
import sys
import urllib.error
import urllib.request

from secure_http import RPC_LIMIT

# Replies stay under Chrome's 1 MiB cap on host-to-extension messages.
RESPONSE_LIMIT = 1_000_000
EXTENSION_ID = re.compile('[a-p]{32}')


def request(connection, payload):
    if os.name != 'nt' and connection.stat().st_mode & 0o077:
        raise ValueError('연결 파일은 현재 사용자만 읽을 수 있어야 합니다.')
    config = json.loads(connection.read_text())
    if not re.fullmatch(r'http://127\.0\.0\.1:\d+/rpc', config['url']):
        raise ValueError('로컬 연결 주소 오류')
    headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['token']}
    req = urllib.request.Request(config['url'], json.dumps(payload).encode(), headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return json.load(error)


def read_frame(stream):
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValueError('잘린 요청 헤더')
    size = struct.unpack('=I',header)[0]
    if not 0 < size <= RPC_LIMIT:
        raise ValueError('요청 크기 오류')
    data = stream.read(size)
    if len(data) != size:
        raise ValueError('잘린 요청')
    return json.loads(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--connection',type=Path,required=True)
    parser.add_argument('--extension-id',required=True)
    parser.add_argument('origin')
    args = parser.parse_args()
    if not EXTENSION_ID.fullmatch(args.extension_id) or args.origin != f'chrome-extension://{args.extension_id}/':
        raise SystemExit('허용되지 않은 확장 프로그램')
    while True:
        try:
            payload = read_frame(sys.stdin.buffer)
            if payload is None:
                return
            result = request(args.connection,payload)
        except Exception:
            result = dict(ok=False,code='unreachable',error='로컬 수집기 연결 실패 · 실행 상태와 연결 파일을 확인하세요.')
        data = json.dumps(result,ensure_ascii=False).encode()
        if len(data) > RESPONSE_LIMIT:
            data = b'{"ok":false,"error":"Response too large"}'
        sys.stdout.buffer.write(struct.pack('=I',len(data))+data)
        sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
