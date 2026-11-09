// 웹이 내려주는 확장 ZIP(npm run zip:web 결과)이 지금 package.json 버전으로 만든 것인지.
// 확장을 고치면 버전을 올리고 zip:web 을 다시 해야 하므로(CLAUDE.md 4장) 버전이 어긋나면 ZIP 을 다시 만들지 않은 것이다.
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fromRepo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(fromRepo(path), 'utf8'));

describe('웹에 올린 확장 ZIP', () => {
  it('extension-release.json 이 지금 버전과 지금 ZIP 파일을 가리킨다', () => {
    const { version } = readJson('extension/package.json');
    const release = readJson('web/src/lib/extension-release.json');
    expect(release.version).toBe(version);
    // publish-to-web.mjs 가 ZIP 을 복사하면서 같이 적는 크기. 다르면 ZIP 만 바꾸고 이 파일은 그대로 둔 것이다
    expect(release.sizeKB).toBe(Math.round(statSync(fromRepo('web/public/syncup-extension.zip')).size / 1024));
  });
});
