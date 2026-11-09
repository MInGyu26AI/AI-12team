// shared/mask-cases.json against the TypeScript masking copy (shared/classify.ts mask()).
// The Python side (ai/syncup_ai/mask.py) reads the same file in ai/tests/test_ai.py MaskTest, so both
// implementations are held to one expected result instead of a comment saying they match.
// Needs the TypeScript compiler from web/ or extension/ (`npm ci` in either). Synthetic strings only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
function typescript() {
  for (const dir of ['web', 'extension']) {
    try { return createRequire(path.join(root, dir, 'package.json'))('typescript'); } catch { /* try the next one */ }
  }
  throw new Error('TypeScript 컴파일러가 없어요. web/ 또는 extension/ 에서 npm ci 를 먼저 실행하세요.');
}

function loadMask() {
  const ts = typescript();
  const source = fs.readFileSync(path.join(root, 'shared', 'classify.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  // classify.ts only has type imports (erased); any runtime import would mean this check no longer sees the real code path.
  const deny = (name) => { throw new Error(`shared/classify.ts 에 런타임 import 가 생겼어요: ${name}`); };
  new Function('exports', 'require', 'module', outputText)(module.exports, deny, module);
  assert.equal(typeof module.exports.mask, 'function', 'shared/classify.ts 에 mask() 가 없어요');
  return module.exports.mask;
}

const mask = loadMask();
const { cases } = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'mask-cases.json'), 'utf8'));
const failures = [];
for (const c of cases) {
  const { text, masked } = mask(c.input);
  const problems = [
    ...c.absent.filter((a) => text.includes(a)).map((a) => `남으면 안 되는 값 "${a}"`),
    ...c.present.filter((p) => !text.includes(p)).map((p) => `있어야 하는 값 "${p}" 없음`),
    ...(masked === c.masked ? [] : [`masked=${masked} (기대 ${c.masked})`]),
  ];
  if (problems.length) failures.push(`${c.name}: ${problems.join(', ')}`);
}
if (failures.length) {
  console.error(`FAIL: TS 마스킹이 공용 사례 ${failures.length}/${cases.length}건과 다릅니다`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log(`PASS: TS 마스킹 공용 사례 ${cases.length}건`);
