const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/** 배포 번들에 쓰지 않고 내보내기 소스만 실행한다. */
require.extensions['.ts'] = function compile(module, filename) {
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, filename);
};

/** 생성된 실제 노드 선택 코드를 실행해 경로·라벨이 HTML 태그나 속성으로 해석되지 않게 확인한다. */
async function main() {
    const root = fs.mkdtempSync(path.join(__dirname, 'html-safety-'));
    const file = path.join(root, 'virtual.ts');
    const attack = '<img src=x onerror="alert(1)">';
    const id = `${file}::${attack}`;
    const data = { version: '1.0', symbols: { [id]: { id, name: attack, kind: 'function', filePath: file, language: 'typescript',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }, relations: {} };
    const { writeGraphExport } = require('../src/storage/export.ts');
    const output = await writeGraphExport(root, data, 0);
    const html = fs.readFileSync(output.htmlPath, 'utf8');
    const start = html.indexOf('function escapeHtml(') >= 0 ? html.indexOf('function escapeHtml(') : html.indexOf('function selectNode(');
    const end = html.indexOf("canvas.addEventListener(", start);
    assert(start > 0 && end > start);
    const details = { innerHTML: '', querySelectorAll: () => [] };
    const sandbox = { DATA: { links: [{ source: 'source', target: attack, relation: 'calls', confidence: 'EXTRACTED' }] },
        nodeDetails: details, draw: () => {}, nodeById: new Map() };
    vm.createContext(sandbox);
    vm.runInContext(html.slice(start, end), sandbox);
    vm.runInContext(`selectNode(${JSON.stringify({ id: 'source', label: attack, source_file: attack, source_location: '1', kind: 'function', community: 0, community_name: attack })})`, sandbox);
    assert(!details.innerHTML.includes('<img'), '검사 패널이 소스 문자열을 HTML로 해석한다.');
    assert(details.innerHTML.includes('&lt;img'), '라벨은 이스케이프한 텍스트로 표시해야 한다.');
    assert(!details.innerHTML.includes(`data-id="${attack}"`), '관계 식별자가 HTML 속성을 벗어난다.');
    console.log(`통과: 생성 HTML의 라벨·경로·관계 속성 이스케이프, ${root}`);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
