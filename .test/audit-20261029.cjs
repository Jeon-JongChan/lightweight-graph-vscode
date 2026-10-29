const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { execFileSync } = require('node:child_process');

/** 배포 번들을 덮어쓰지 않고 검토 대상 TypeScript를 메모리에서 변환한다. */
require.extensions['.ts'] = function compile(module, filename) {
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, filename);
};

/** 기존 검사 밖의 작은 반례를 기록하며 제품 소스와 전역 설정을 변경하지 않는다. */
async function main() {
    const project = path.resolve(__dirname, '..');
    const root = fs.mkdtempSync(path.join(__dirname, 'audit-20261029-'));
    const { buildProjectIndex } = require('../src/core/build.ts');
    const { GraphTools } = require('../src/mcp/tools.ts');
    const cases = [
        { name: 'file-dependencies', files: { 'main.ts': "import { work } from './lib';\nexport function entry() { work(); }", 'lib.ts': 'export function work() {}' } },
        { name: 'empty-module', files: { 'main.ts': "import './empty';\nexport function entry() {}", 'empty.ts': '// 부작용 모듈의 최소 입력\n' } },
        { name: 'function-expressions', files: { 'main.js': 'function helper() {}\nconst entry = function() { helper(); };\nfunction* stream() { helper(); }\n' } },
        { name: 'java-overloads', files: { 'Main.java': 'class Main {\n void work() {}\n void work(int value) {}\n void entry() { work(); work(1); }\n}\n' } },
        { name: 'python-override-impact', files: { 'main.py': 'class Base:\n    def work(self): pass\nclass Child(Base):\n    def work(self): pass\ndef entry(item: Base):\n    item.work()\n' } },
        { name: 'tsconfig-extends', files: { 'tsconfig.json': '{"extends":"./base.json"}', 'base.json': '{"compilerOptions":{"paths":{"@lib/*":["src/*"]}}}', 'main.ts': "import { work } from '@lib/lib';\nexport function entry() { work(); }", 'src/lib.ts': 'export function work() {}' } },
        { name: 'unresolved-callers', files: { 'a.ts': 'export function work() {}', 'b.ts': 'export function work() {}', 'main.ts': 'export function entry() { work(); }' } }
    ];
    const results = [];
    for (const sample of cases) {
        const directory = path.join(root, sample.name);
        fs.mkdirSync(directory, { recursive: true });
        for (const [file, code] of Object.entries(sample.files)) {
            fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
            fs.writeFileSync(path.join(directory, file), code);
        }
        const built = await buildProjectIndex(directory, project);
        assert.equal(built.parseErrorFiles.length, 0, sample.name);
        const data = JSON.parse(fs.readFileSync(built.cachePath, 'utf8'));
        const tools = new GraphTools(() => data, () => directory);
        const symbols = Object.values(data.symbols);
        const relations = Object.values(data.relations);
        const row = { name: sample.name, symbols: symbols.map(s => ({ id: path.relative(directory, s.id), kind: s.kind, line: s.range.start.line + 1 })),
            calls: relations.filter(r => r.kind === 'call').map(r => ({ source: path.relative(directory, r.sourceId), target: r.targetId, certainty: r.certainty })) };
        if (sample.name === 'file-dependencies') {
            row.expected = '파일 경로로 임포트 의존성 1개 이상';
            row.actual = tools.getDependencies(path.join(directory, 'main.ts'));
            row.defectReproduced = row.actual.length === 0 && relations.some(r => r.kind === 'import');
        } else if (sample.name === 'empty-module' || sample.name === 'tsconfig-extends') {
            row.expected = '로컬 임포트가 RESOLVED';
            row.actual = relations.filter(r => r.kind === 'import');
            row.defectReproduced = row.actual.some(r => r.certainty !== 'RESOLVED');
        } else if (sample.name === 'function-expressions') {
            row.expected = 'entry와 stream 선언 및 각각의 helper 호출';
            row.defectReproduced = !symbols.some(s => s.name === 'entry' && s.kind === 'function') && !symbols.some(s => s.name === 'stream');
        } else if (sample.name === 'java-overloads') {
            row.expected = 'work 오버로드 선언 2개';
            row.defectReproduced = symbols.filter(s => s.name === 'work').length === 1;
        } else if (sample.name === 'python-override-impact') {
            row.expected = 'Child.work의 영향 범위에 Base 타입으로 호출하는 entry 포함';
            row.actual = tools.getImpact(`${path.join(directory, 'main.py')}::Child::work`).map(s => s.name);
            row.defectReproduced = !row.actual.includes('entry') && relations.some(r => r.targetId.endsWith('::Base::work'));
        } else if (sample.name === 'unresolved-callers') {
            row.expected = '정확한 a.ts::work ID의 확정 호출자는 0개';
            row.actual = tools.getCallers(`${path.join(directory, 'a.ts')}::work`);
            row.defectReproduced = row.actual.some(r => r.targetId === 'unknown::work');
        }
        if (process.argv[2]) {
            // 비교 워커가 src만 선택하므로 전체 fixture 파일을 명시해 직접 추출한다.
            const python = 'import json,sys,hashlib,importlib.metadata; from pathlib import Path; from graphify.extract import extract; r=Path(sys.argv[1]); p=[r/f for f in json.loads(sys.argv[2]) if Path(f).suffix in {".ts",".js",".py",".java"}]; g=extract(p,root=r,cache_root=r/".tools"/".graphify"/"upstream",parallel=False); print(json.dumps({"version":importlib.metadata.version("graphifyy"),"nodes":g["nodes"],"edges":g["edges"]}))';
            const output = execFileSync(process.argv[2], ['-c', python, directory, JSON.stringify(Object.keys(sample.files))], {
                encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', GRAPHIFY_OUT: '.tools/.graphify' }
            });
            row.graphify = JSON.parse(output.trim().split('\n').pop());
        }
        results.push(row);
        console.log(`${row.name}: 문제 재현 ${row.defectReproduced}`);
    }
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(results, null, 2));
    assert(results.every(row => row.defectReproduced), '현재 검토한 문제의 재현 상태가 바뀌었다.');
    console.log(`검토 증거: ${root}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
