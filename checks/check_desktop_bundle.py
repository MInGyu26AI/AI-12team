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
print('PASS: bundled runtime → native host → setup.status (no Chrome registration, no key issued)')
