"""Local OCR (files.ocr): page images to text with a vision model of the Ollama running on this PC.

The images come from the web page that read an uploaded PDF or photo in the browser. They go to the Ollama of this
machine and nowhere else: the address (OLLAMA_HOST, default http://127.0.0.1:11434) must be a loopback one, and a model
served remotely (cloud) is refused, as in privacy_model.py. The text goes back to the caller, which sends it through
turns.append like any other input, so masking and the on-device privacy check still apply. Nothing here is logged but
failure kinds.
"""
from __future__ import annotations

import base64
import binascii
import http.client
import json
import os
import re
import socket
import urllib.parse

from diagnostics import failure
from privacy_model import LOOPBACK, MODEL_NAME

DEFAULT_URL = 'http://127.0.0.1:11434'
DEFAULT_MODELS = ('gemma4:e4b', 'gemma4:12b', 'gemma4:e4b-it-qat')  # the first one installed is used
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # decoded
MAX_PAGES = 40  # per request
PAGE_TIMEOUT = 120  # seconds per page
TAGS_TIMEOUT = 10
MAX_REPLY = 4 * 1024 * 1024
NUM_CTX = 8192
NUM_PREDICT = 6000  # a dense page is about 3000 tokens; this stops a model that loops on its own text
PROMPT = ('이 이미지는 문서의 한 쪽이다. 쪽에 있는 모든 글자를 읽는 순서대로 그대로 옮겨 적어라. '
          '표는 한 줄이 한 행이 되게 칸을 " | "로 이어 적어라. 설명, 요약, 번역, 머리말, 코드 블록 표시는 쓰지 마라. '
          '글자가 없으면 아무것도 쓰지 마라.\n'
          'Transcribe all the text on this page faithfully, in reading order. Keep tables as lines, cells separated by " | ". '
          'No commentary, summary, translation or code fences. If there is no text, answer with nothing.')
PNG = b'\x89PNG\r\n\x1a\n'
JPEG = b'\xff\xd8\xff'
REASONS = ('model_unavailable', 'empty', 'too_large', 'bad_image')


class Unavailable(Exception):
    """No usable local model: not reachable, not installed, not local, no answer in time or an HTTP failure."""


def _address():
    """(host, port) of the Ollama to call; Unavailable unless it is a loopback address."""
    raw = os.environ.get('OLLAMA_HOST', '').strip() or DEFAULT_URL
    if '://' not in raw:
        raw = 'http://' + raw
    try:
        parsed = urllib.parse.urlsplit(raw)
        port = parsed.port or 11434
    except ValueError:
        raise Unavailable from None
    if (parsed.scheme != 'http' or parsed.username or parsed.password or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment):
        raise Unavailable
    host = {None: '127.0.0.1', 'localhost': '127.0.0.1', '0.0.0.0': '127.0.0.1'}.get(parsed.hostname, parsed.hostname)
    if host not in LOOPBACK:
        raise Unavailable
    return host, port


def _call(address, method, path, body, timeout):
    """(status, parsed JSON or None) of one request to the local Ollama. Unavailable when it does not answer in time."""
    connection = http.client.HTTPConnection(*address, timeout=timeout)
    try:
        connection.request(method, path, json.dumps(body) if body is not None else None,
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        data = response.read(MAX_REPLY + 1)
    except (socket.timeout, TimeoutError, OSError, http.client.HTTPException):
        raise Unavailable from None
    finally:
        connection.close()
    if len(data) > MAX_REPLY:
        raise Unavailable
    try:
        return response.status, json.loads(data)
    except ValueError:
        return response.status, None


def _local(entry):
    return isinstance(entry, dict) and not entry.get('remote_host') and not entry.get('remote_model')


def pick_model(address):
    """The model to read pages with: SYNCUP_VISION_MODEL, else the first of DEFAULT_MODELS installed here.
    Unavailable when none is installed or the runtime does not answer."""
    status, tags = _call(address, 'GET', '/api/tags', None, TAGS_TIMEOUT)
    if status != 200 or not isinstance(tags, dict) or not isinstance(tags.get('models'), list):
        raise Unavailable
    installed = {name for m in tags['models'] if _local(m) for name in (m.get('name'), m.get('model')) if isinstance(name, str)}
    wanted = os.environ.get('SYNCUP_VISION_MODEL', '').strip()
    if wanted:
        if not MODEL_NAME.fullmatch(wanted) or 'cloud' in wanted.lower() or wanted not in installed:
            raise Unavailable
        return wanted
    for name in DEFAULT_MODELS:
        if name in installed:
            return name
    raise Unavailable


def _clean(content):
    """The model's answer without a code fence around it (the prompt forbids one, models add one anyway)."""
    text = content.strip() if isinstance(content, str) else ''
    fence = re.fullmatch(r'```[A-Za-z0-9_-]*[ \t]*\n(.*?)\n?```', text, re.S)
    return (fence.group(1) if fence else text).strip()


def read_page(address, model, image):
    """(True, text) or (False, reason) for one page image (decoded bytes)."""
    body = dict(model=model, stream=False, think=False, keep_alive='5m',
                options=dict(temperature=0, num_ctx=NUM_CTX, num_predict=NUM_PREDICT),
                messages=[dict(role='user', content=PROMPT, images=[base64.b64encode(image).decode()])])
    try:
        status, reply = _call(address, 'POST', '/api/chat', body, PAGE_TIMEOUT)
    except Unavailable:
        return False, 'model_unavailable'
    if status != 200 or not isinstance(reply, dict):
        # Ollama answers 400/500 for an image it cannot decode; the body is only looked at here, never kept.
        text = json.dumps(reply, ensure_ascii=False).lower() if reply is not None else ''
        return False, 'bad_image' if status in (400, 500) and 'image' in text else 'model_unavailable'
    if reply.get('remote_host') or reply.get('remote_model'):
        return False, 'model_unavailable'
    message = reply.get('message')
    text = _clean(message.get('content') if isinstance(message, dict) else None)
    return (True, text) if text else (False, 'empty')


def decode_image(value):
    """The image bytes of a base64 string (a data: URL is fine), or the reason it cannot be used: 'too_large' above
    8 MB decoded, 'bad_image' for what is not base64 PNG or JPEG."""
    if not isinstance(value, str):
        return None, 'bad_image'
    if value.startswith('data:'):
        value = value.partition(',')[2]
    value = ''.join(value.split())
    if len(value) > MAX_IMAGE_BYTES * 4 // 3 + 4:
        return None, 'too_large'
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None, 'bad_image'
    if len(raw) > MAX_IMAGE_BYTES:
        return None, 'too_large'
    if not (raw.startswith(PNG) or raw.startswith(JPEG)):
        return None, 'bad_image'
    return raw, None


def _check(params):
    pages = params.get('pages')
    if not isinstance(pages, list) or not 0 < len(pages) <= MAX_PAGES:
        raise ValueError(f'쪽 이미지는 한 번에 1~{MAX_PAGES}개를 보내세요.')
    if set(params) - {'pages', 'name'}:
        raise ValueError('문자 인식 필드 오류')
    if 'name' in params and (not isinstance(params['name'], str) or len(params['name']) > 300):
        raise ValueError('파일 이름 오류')
    for page in pages:
        if (not isinstance(page, dict) or set(page) != {'page', 'image'} or type(page['page']) is not int
                or not 0 <= page['page'] <= 100000):
            raise ValueError('쪽 형식 오류')
    return pages


def ocr(params):
    """files.ocr: {pages: [{page, image}], name?} -> {model, pages: [{page, ok: True, text} | {page, ok: False, reason}]}.

    ValueError (Korean) for a malformed request; every page problem is a `reason` of that page instead, so one bad
    page does not lose the others. model is None when no local vision model could be used.
    """
    pages = _check(params)
    decoded = [decode_image(p['image']) for p in pages]
    model = address = None
    if any(reason is None for _, reason in decoded):
        try:
            address = _address()
            model = pick_model(address)
        except Unavailable:
            model = None
    results = []
    for page, (image, reason) in zip(pages, decoded):
        if reason is None and model is None:
            reason = 'model_unavailable'
        if reason is None:
            try:
                ok, value = read_page(address, model, image)
            except Exception as error:  # a surprise must not lose the pages already read
                failure('local_ocr', error)
                ok, value = False, 'model_unavailable'
            results.append(dict(page=page['page'], ok=True, text=value) if ok else dict(page=page['page'], ok=False, reason=value))
        else:
            results.append(dict(page=page['page'], ok=False, reason=reason))
    return dict(model=model, pages=results)
