"""The built app must answer a native-host setup.status frame without local Python or Chrome registration."""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
binary = ROOT / ('dist/desktop/SyncUp/SyncUp.exe' if sys.platform == 'win32' else 'dist/desktop/SyncUp.app/Contents/MacOS/SyncUp')
if not binary.is_file():
    raise SystemExit('Build the desktop bundle before this check.')
bundle = ROOT / ('dist/desktop/SyncUp' if sys.platform == 'win32' else 'dist/desktop/SyncUp.app')
if sys.platform == 'win32':
    # What a user sees after unpacking the Windows ZIP: the app, its runtime folder and the note, nothing loose.
    top = sorted(entry.name for entry in bundle.iterdir())
    assert top == ['README.txt', 'SyncUp.exe', '_internal'], f'unexpected files next to SyncUp.exe: {top}'
    assert '_internal' in (bundle / 'README.txt').read_text(encoding='utf-8-sig'), 'README.txt must explain _internal'
# Nothing that holds a key or a login belongs in a download (collector state, env files, certificates' private keys).
PRIVATE_NAMES = {'team.json', 'connection.json', 'syncup-team.key', 'id_rsa', 'id_ed25519'}
private = [str(path.relative_to(bundle)) for path in bundle.rglob('*') if path.is_file() and (
    path.name in PRIVATE_NAMES or path.name == '.env' or path.name.startswith('.env.') or path.suffix in ('.key', '.p12', '.pfx'))]
assert not private, f'private files in the bundle: {private}'
with tempfile.TemporaryDirectory(prefix='syncup-desktop-probe-') as folder:
    payload=json.dumps({'version':1,'method':'setup.status','params':{}}).encode()
    result=subprocess.run([str(binary),'native-host','--connection',str(Path(folder)/'state/connection.json'),
        '--extension-id','a'*32,'--team-api','https://team.example.com','chrome-extension://'+'a'*32+'/'],
        input=struct.pack('=I',len(payload))+payload,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,
        env={k:v for k,v in os.environ.items() if not k.startswith(('PYTHON','SYNCUP','AI_','OPENAI'))})
    assert result.returncode == 0, 'bundled native host failed'
    assert len(result.stdout) >= 4, 'bundled native host did not return a frame'
    size=struct.unpack('=I',result.stdout[:4])[0]
    response=json.loads(result.stdout[4:4+size])
    assert response == {'ok':True,'result':{'hostReady':True,'keyPresent':False,'expiresAt':None}}, 'unexpected bundled status'
print('PASS: bundled runtime -> native host -> setup.status (no Chrome registration, no key issued)')
