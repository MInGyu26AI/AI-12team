const { spawn } = require('node:child_process');
const path = require('node:path');

const project = process.argv[2];
const state = process.argv[3];
if (!project || !state) {
  console.error('Usage: node --env-file=KEY_FILE launch.cjs PROJECT_DIRECTORY NEW_STATE_DIRECTORY');
  process.exit(2);
}
const child = spawn(process.platform === 'win32' ? 'python' : 'python3', [path.join(__dirname, 'app.py'), 'run', '--project', project, '--state', state, ...process.argv.slice(4)], { stdio: 'inherit' });
child.on('error', () => { console.error('Python 실행에 실패했습니다.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => child.kill('SIGINT'));
}
