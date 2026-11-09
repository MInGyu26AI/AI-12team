// node:test 에서 web/src·shared 의 TypeScript 모듈을 번들러 없이 읽는다.
// web/node_modules 의 TypeScript 로 파일마다 CommonJS 로 바꾸고, tsconfig.json 의 '@/'·'@shared/' 별칭을 따라간다.
// 화면 상태가 없는 모듈(순수 함수·API 어댑터)을 시험하는 용도다. JSX 화면은 다루지 않는다.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = fileURLToPath(import.meta.url);
const WEB = path.resolve(path.dirname(HERE), "..");
const requirePackage = createRequire(HERE); // react·sonner 같은 패키지는 web/node_modules 에서 그대로
const ALIASES = [
  ["@/", path.join(WEB, "src")],
  ["@shared/", path.join(WEB, "..", "shared")],
];
const loaded = new Map();

const isProjectFile = (specifier) => specifier.startsWith(".") || ALIASES.some(([prefix]) => specifier.startsWith(prefix));

function resolveFile(specifier, from) {
  const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix));
  const base = alias ? path.join(alias[1], specifier.slice(alias[0].length)) : path.resolve(path.dirname(from), specifier);
  const found = [base, `${base}.ts`, path.join(base, "index.ts")].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!found) throw new Error(`${from} 에서 ${specifier} 를 찾지 못했어요`);
  return found;
}

function loadFile(file) {
  if (loaded.has(file)) return loaded.get(file).exports;
  const mod = { exports: {} };
  loaded.set(file, mod);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const requireFrom = (specifier) => (isProjectFile(specifier) ? loadFile(resolveFile(specifier, file)) : requirePackage(specifier));
  new Function("exports", "require", "module", outputText)(mod.exports, requireFrom, mod);
  return mod.exports;
}

/** load("@/lib/review-candidates") → 그 모듈의 export */
export const load = (specifier) => loadFile(resolveFile(specifier, HERE));
