// 확장 zip 을 웹(/web/public)에 올려 https://<배포주소>/syncup-extension.zip 으로 받을 수 있게 한다.
// 사용: cd extension && npm run zip:web   (그다음 웹을 다시 배포해야 사이트에 반영됨)
import { copyFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const zipName = readdirSync(join(root, '.output')).find((f) => f.endsWith(`-${version}-chrome.zip`));
if (!zipName) throw new Error(`.output 에 ${version} 버전 zip 이 없어요. 먼저 "wxt zip" 을 실행하세요.`);

const src = join(root, '.output', zipName);
const webDir = join(root, '..', 'web');
copyFileSync(src, join(webDir, 'public', 'syncup-extension.zip'));

const info = {
  version,
  sizeKB: Math.round(statSync(src).size / 1024),
  builtAt: new Date().toISOString(),
};
writeFileSync(join(webDir, 'src', 'lib', 'extension-release.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`웹에 올림: web/public/syncup-extension.zip (v${info.version}, ${info.sizeKB}KB) → 웹 재배포 필요`);
