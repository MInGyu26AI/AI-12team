"""Per-user desktop installation. No administrator rights, no shell commands, no downloaded code execution.

The bundled app supplies its own runtime, scanner and extension. Existing Chrome registration is backed up
before replacement. Tests pass an isolated home and registry adapter; importing this module changes nothing.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid
import zipfile

from prepare_native import HOST_NAME, _posix_launcher, _windows_launcher
from private_files import make_private_directory
from team_client import team_api_url

EXTENSION_ID = re.compile(r'[a-p]{32}')


def install_root(home=None, platform=None):
    home = Path(home or Path.home())
    platform = platform or sys.platform
    if platform == 'darwin':
        return home / 'Library/Application Support/SyncUp'
    if platform == 'win32':
        return home / 'AppData/Local/SyncUp'
    raise ValueError('Mac과 Windows에서 설치할 수 있어요.')


def private_dir(path):
    if path.is_symlink():
        raise ValueError('연결된 폴더에는 설치하지 않습니다.')
    make_private_directory(path)
    if sys.platform != 'win32':
        path.chmod(0o700)


def read_config(resource_root):
    value = json.loads((Path(resource_root) / 'desktop-config.json').read_text(encoding='utf-8'))
    from urllib.parse import urlsplit
    web = urlsplit(value['web_url'])
    demo = value.get('local_demo') is True
    local_web = demo and web.scheme == 'http' and web.hostname in ('localhost', '127.0.0.1')
    hosted_web = web.scheme == 'https' and web.hostname and web.hostname.endswith('.vercel.app') and not web.port
    if (not (local_web or hosted_web) or web.username or web.password
            or web.query or web.fragment or web.path not in ('', '/')):
        raise ValueError('배포 웹 주소를 확인해 주세요.')
    value['web_url'] = f'{web.scheme}://{web.netloc}'
    value['team_api'] = team_api_url(value['team_api'])
    if not value['team_api'].startswith('https://') and not (demo and local_web):
        raise ValueError('운영 서버는 HTTPS 주소여야 합니다.')
    if demo and (not local_web or urlsplit(value['team_api']).hostname != '127.0.0.1'):
        raise ValueError('로컬 시연은 이 컴퓨터의 웹과 서버만 사용할 수 있어요.')
    return value


def unpack_extension(archive, destination):
    """Only a bundled ZIP, with no absolute/traversal/symlink entries. Keep its stable path across upgrades."""
    with zipfile.ZipFile(archive) as z:
        if len(z.infolist()) > 5000 or sum(i.file_size for i in z.infolist()) > 50 * 1024 * 1024:
            raise ValueError('확장 파일 크기를 확인해 주세요.')
        for info in z.infolist():
            path = Path(info.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in info.filename or (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('안전하지 않은 확장 파일입니다.')
        manifest = json.loads(z.read('manifest.json'))
        if manifest.get('manifest_version') != 3:
            raise ValueError('확장 버전을 확인해 주세요.')
        if destination.exists():
            # Do not overwrite a folder Chrome may currently be reading. A changed package gets a new folder.
            raise FileExistsError('확장 폴더가 이미 있어요.')
        z.extractall(destination)
    return manifest['version']


def copy_runtime(source, executable_relative, root):
    source, relative = Path(source), Path(executable_relative)
    if relative.is_absolute() or '..' in relative.parts or not (source / relative).is_file():
        raise ValueError('실행 파일을 확인해 주세요.')
    private_dir(root)
    target = root / 'versions' / uuid.uuid4().hex / source.name
    private_dir(target.parent)
    shutil.copytree(source, target, symlinks=True)
    return target / relative


def register(extension_id, executable, root, team_api, home=None, platform=None, registry=None, local_demo=False):
    """Register only the ID the user supplied. Keep both the previous registration and launchers intact."""
    if not EXTENSION_ID.fullmatch(extension_id):
        raise ValueError('Chrome에 표시된 확장 ID 32자(a~p)를 붙여 넣어 주세요.')
    platform = platform or sys.platform
    if platform not in ('darwin', 'win32'):
        raise ValueError('지원하지 않는 운영체제입니다.')
    api = team_api_url(team_api)
    if not api.startswith('https://') and not local_demo:
        raise ValueError('팀 서버 주소는 HTTPS여야 합니다.')
    root, home, executable = Path(root), Path(home or Path.home()), Path(executable)
    if not executable.is_file():
        raise ValueError('설치한 실행 파일을 찾지 못했어요.')
    private_dir(root)
    state = root / 'state'
    private_dir(state)
    # Do not bind existing credentials to another server.
    from key_setup import saved_connection
    saved = saved_connection(state)
    if saved and saved['api_url'] != api:
        raise ValueError('이미 다른 팀 서버에 연결된 PC예요. 기존 연결을 먼저 확인해 주세요.')
    native = root / 'native' / uuid.uuid4().hex
    private_dir(native)
    command = [str(executable), 'native-host', '--connection', str(state / 'connection.json'),
               '--extension-id', extension_id, '--team-api', api]
    launcher = (_windows_launcher if platform == 'win32' else _posix_launcher)(native, command)
    manifest = dict(name=HOST_NAME, description='SyncUp local approval service', path=str(launcher),
                    type='stdio', allowed_origins=[f'chrome-extension://{extension_id}/'])
    generated = native / (HOST_NAME + '.json')
    generated.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    if sys.platform != 'win32':
        generated.chmod(0o600)
    backup_dir = root / 'registration-backups'
    private_dir(backup_dir)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    backup = None
    if platform == 'darwin':
        target = home / 'Library/Application Support/Google/Chrome/NativeMessagingHosts' / generated.name
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink():
            raise ValueError('기존 Chrome 설정이 연결 파일입니다. 직접 확인해 주세요.')
        if target.exists():
            backup = backup_dir / (stamp + '.json')
            shutil.copy2(target, backup)
            backup.chmod(0o600)
        staged = target.with_name(target.name + '.' + uuid.uuid4().hex)
        try:
            shutil.copyfile(generated, staged)
            staged.chmod(0o600)
            os.replace(staged, target)
        finally:
            if staged.exists():
                staged.unlink()
    else:
        if registry is None:
            import winreg as registry
        key_path = r'Software\Google\Chrome\NativeMessagingHosts' + '\\' + HOST_NAME
        previous = None
        try:
            with registry.OpenKey(registry.HKEY_CURRENT_USER, key_path) as key:
                previous, _ = registry.QueryValueEx(key, '')
        except FileNotFoundError:
            pass
        if previous is not None:
            backup = backup_dir / (stamp + '.json')
            backup.write_text(json.dumps({'registry_key': key_path, 'previous': previous}, ensure_ascii=False), encoding='utf-8')
        with registry.CreateKey(registry.HKEY_CURRENT_USER, key_path) as key:
            registry.SetValueEx(key, '', 0, registry.REG_SZ, str(generated))
    return dict(manifest=str(generated), backup=str(backup) if backup else None, state=str(state))
