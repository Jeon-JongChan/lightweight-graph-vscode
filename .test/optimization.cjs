const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');
const { execFileSync } = require('node:child_process');

/** 실행 번들을 덮어쓰지 않는 테스트 전용 TypeScript 로더다. */
require.extensions['.ts'] = function compile(module, filename) {
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, filename);
};

/** 증분 갱신·스코프·질의 제한을 실제 WASM으로 확인하고 해석기 시간을 기록한다. */
async function main() {
    const project = path.resolve(__dirname, '..');
    const root = fs.mkdtempSync(path.join(__dirname, 'optimization-'));
    const { GraphIndex } = require('../src/storage/index.ts');
    const { GraphTools } = require('../src/mcp/tools.ts');
    const hasBaseline = fs.existsSync(path.join(__dirname, 'optimization-before/src/storage/index.ts'));
    // WASM 초기화가 CommonJS export를 바꾸므로 두 구현 모두 초기화 전에 로드한다.
    const baseline = hasBaseline ? require('./optimization-before/src/storage/index.ts').GraphIndex : null;
    const index = new GraphIndex(root, project);
    const failures = [];
    /** 독립적인 반례의 실패를 모아 한 번의 검사로 보고한다. */
    function check(condition, message) { if (!condition) failures.push(message); }
    /** 호출자가 현재 존재하는 대상에만 연결됐는지 확인한다. */
    function calls(name) {
        return Object.values(index.getGraphData().relations).filter(rel => rel.kind === 'call' && rel.sourceId.endsWith(`::${name}`));
    }
    await index.initialize(false);
    try {
        const a = path.join(root, 'a.ts');
        const b = path.join(root, 'b.ts');
        fs.writeFileSync(a, "import { task } from './b'; export function entry() { task(); }");
        fs.writeFileSync(b, 'export function task() {}');
        await index.updateFile(a, true);
        await index.updateFile(b, true);
        index.resolveImports(); index.resolveRelations();
        check(calls('entry').some(rel => rel.targetId === `${b}::task`), '초기 호출 해석');
        fs.writeFileSync(b, 'export function renamed() {}');
        await index.updateFile(b);
        check(!calls('entry').some(rel => rel.targetId === `${b}::task`), '대상 이름 변경 후 이전 호출 연결 잔존');
        fs.writeFileSync(b, 'export function task() {}');
        await index.updateFile(b);
        check(calls('entry').some(rel => rel.targetId === `${b}::task`), '대상 복구 후 호출 재해석 누락');
        await index.removeFile(b);
        check(!calls('entry').some(rel => rel.targetId === `${b}::task`), '색인 대상 제거 후 이전 호출 연결 잔존');

        const broken = path.join(root, 'broken.ts');
        fs.writeFileSync(broken, 'function broken( {');
        await index.updateFile(broken);
        fs.writeFileSync(broken, 'function repaired() {}');
        await index.updateFile(broken);
        check(!index.getParseErrorFiles().includes(broken), '문법 오류 수정 후 경고 잔존');

        const scope = path.join(root, 'scope.ts');
        fs.writeFileSync(scope, `function outerA() { function helper() {} helper(); }
function outerB() { function helper() {} helper(); }
class A { ping() {} runA() { this.ping(); } }
class B { ping() {} runB() { this.ping(); } }
function bare() { ping(); }
interface Contract { execute(): void; }
function invalid() { Contract(); }
function caps() { outerA(); outerB(); }
`);
        await index.updateFile(scope);
        check(calls('outerA').some(rel => rel.targetId === `${scope}::outerA::helper`), '중첩 함수의 렉시컬 스코프 누락');
        check(calls('outerB').some(rel => rel.targetId === `${scope}::outerB::helper`), '다른 중첩 함수의 렉시컬 스코프 누락');
        check(!calls('invalid').some(rel => rel.targetId === `${scope}::Contract`), '호출 불가능한 인터페이스를 호출 대상으로 오연결');
        const tools = new GraphTools(() => index.getGraphData(), () => root);
        check(tools.queryGraph('', 'bfs', 3, 2).nodes.length === 0, '빈 질의가 전체 그래프 시드를 생성');
        check(tools.queryGraph('outerA outerB caps', 'bfs', 3, 1).nodes.length <= 1, 'max_nodes보다 시드가 많이 반환됨');
        check(tools.queryGraph('outerA outerB caps', 'bfs', 3, 1.5).nodes.length <= 1, '소수 max_nodes의 시드 제한 오류');
        const saved = JSON.parse(fs.readFileSync(path.join(root, '.tools/.graphify/graph-cache.json'), 'utf8'));
        check(saved.extractedRelations && Object.keys(saved.extractedRelations).length > 0, '재해석 가능한 원시 관계가 캐시에 없음');
        const typed = path.join(root, 'typed.ts');
        const ui = path.join(root, 'ui.tsx');
        fs.writeFileSync(ui, 'export function renderUi() {}');
        fs.writeFileSync(typed, "import { renderUi } from './ui'; function page() { renderUi(); }");
        await index.updateFile(ui, true);
        await index.updateFile(typed);
        check(calls('page').some(rel => rel.targetId === `${ui}::renderUi`), 'TS→TSX의 명시적 교차 임포트 호출 누락');
        const special = path.join(root, 'name,}.ts');
        const foo = path.join(root, 'foo.ts');
        const directoryIndex = path.join(root, 'foo/index.js');
        fs.mkdirSync(path.dirname(directoryIndex), { recursive: true });
        fs.writeFileSync(special, 'export function special() {}');
        fs.writeFileSync(foo, 'export function foo() {}');
        fs.writeFileSync(directoryIndex, 'export function directory() {}');
        fs.writeFileSync(path.join(root, 'tsconfig.json'), '{ "compilerOptions": { "paths": { "@special": ["./name,}"], }, }, }');
        const imports = path.join(root, 'imports.ts');
        fs.writeFileSync(imports, "import { special } from '@special'; import { foo } from './foo'; function importsMain() { special(); foo(); }");
        for (const file of [special, foo, directoryIndex, imports]) await index.updateFile(file, true);
        index.resolveRelations();
        const importRelations = Object.values(index.getGraphData().relations).filter(rel => rel.sourceId === imports && rel.kind === 'import');
        check(importRelations.some(rel => rel.targetId === special), 'JSONC 문자열 안의 쉼표·중괄호가 손상됨');
        check(importRelations.some(rel => rel.targetId === foo), '파일 후보보다 디렉터리 index.js가 먼저 선택됨');
        const pythonCaller = path.join(root, 'pkg/sub/main.py');
        const pythonParent = path.join(root, 'pkg/helpers.py');
        const pythonSibling = path.join(root, 'pkg/sub/helpers.py');
        const pythonPackage = path.join(root, 'pkg/__init__.py');
        fs.mkdirSync(path.dirname(pythonCaller), { recursive: true });
        fs.writeFileSync(pythonParent, 'def parent_task(): pass');
        fs.writeFileSync(pythonSibling, 'def sibling_task(): pass');
        fs.writeFileSync(pythonPackage, 'def package_task(): pass');
        const pythonRootOnly = path.join(root, 'missing.py');
        fs.writeFileSync(pythonRootOnly, 'def absent_task(): pass');
        fs.writeFileSync(pythonCaller, 'from ..helpers import parent_task\nfrom .helpers import sibling_task\nfrom .. import package_task\nfrom ..missing import absent_task\ndef python_main():\n    parent_task()\n    sibling_task()\n    package_task()\n');
        for (const file of [pythonParent, pythonSibling, pythonPackage, pythonRootOnly, pythonCaller]) await index.updateFile(file, true);
        index.resolveRelations();
        const pythonImports = Object.values(index.getGraphData().relations).filter(rel => rel.sourceId === pythonCaller && rel.kind === 'import');
        for (const target of [pythonParent, pythonSibling, pythonPackage]) {
            assert(pythonImports.some(rel => rel.targetId === target), `Python 상대 임포트 대상 누락: ${target}`);
        }
        assert(!pythonImports.some(rel => rel.targetId === pythonRootOnly), '없는 상대 모듈을 루트의 동명 파일로 대체하면 안 된다.');
        const reloaded = new GraphIndex(root, project);
        try {
            await reloaded.initialize();
            fs.writeFileSync(ui, 'export function replacedUi() {}');
            await reloaded.updateFile(ui);
            check(!Object.values(reloaded.getGraphData().relations).some(rel => rel.targetId === `${ui}::renderUi`), '캐시 재로드 후 삭제된 대상 연결 잔존');
        } finally { reloaded.dispose(); }
        const { GraphCache } = require('../src/storage/cache.ts');
        const cache = new GraphCache(root);
        const legacy = await cache.load();
        delete legacy.extractedRelations;
        await cache.save(legacy);
        const migrated = new GraphIndex(root, project);
        try {
            await migrated.initialize();
            check(Object.keys(migrated.getGraphData().extractedRelations).length > 0, '이전 형식 캐시의 원시 관계 복원 누락');
            check(Object.values(migrated.getGraphData().symbols).some(symbol => symbol.name === 'repaired'), '이전 캐시 재파싱 후 심볼 누락');
        } finally { migrated.dispose(); }
        const malformed = { ...legacy, extractedRelations: [] };
        await cache.save(malformed);
        check(await cache.load() === null, '잘못된 원시 관계 캐시를 거부하지 않음');
        await cache.save(legacy);
    } finally { index.dispose(); }

    const timings = {};
    for (const [name, Constructor] of [...(baseline ? [['before', baseline]] : []), ['after', GraphIndex]]) {
        const samples = [];
        for (let run = 0; run < 4; run++) {
            const graph = new Constructor(root, project);
            const data = graph.getGraphData();
            for (let n = 0; n < 2500; n++) {
                const filePath = path.join(root, `file${n}.ts`);
                const id = `${filePath}::fn${n}`;
                data.symbols[id] = { id, name: `fn${n}`, kind: 'function', filePath, language: 'typescript', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } };
                const relId = `${filePath}::call::fn${n}->fn${(n + 1) % 2500}`;
                data.relations[relId] = { id: relId, sourceId: id, targetId: `unknown::fn${(n + 1) % 2500}`, kind: 'call', certainty: 'EXTRACTED' };
            }
            const started = performance.now();
            if (data.extractedRelations) data.extractedRelations = structuredClone(data.relations);
            graph.resolveRelations();
            const elapsed = performance.now() - started;
            assert.equal(Object.values(data.relations).filter(rel => !rel.targetId.startsWith('unknown::')).length, 2500);
            if (name === 'after') assert(Object.values(data.relations).every(rel => rel.confidenceScore === 0.85));
            if (run > 0) samples.push(elapsed);
            graph.dispose();
        }
        samples.sort((a, b) => a - b);
        timings[name] = { medianMs: samples[1], samples };
    }
    const parityCases = [
        { caller: 'src/main.ts', files: { a: 'src/helper.ts', b: 'tests/helper.ts' } },
        { caller: 'tests/main.ts', files: { a: 'src/helper.ts', b: 'tests/helper.ts' } },
        { caller: 'src/main.ts', files: { a: 'src/main.ts', b: 'src/helper.ts' } },
        { caller: 'src/main.ts', files: { a: 'src/a.ts', b: 'src/b.ts' } },
        { caller: 'src/app/main.ts', files: { a: 'src/app/service/a.ts', b: 'other/a.ts' } },
        { caller: 'src/main.ts', files: { a: 'tests/a.ts', b: 'tests/b.ts' } },
        { caller: 'C:\\repo\\src\\main.ts', files: { a: 'C:/repo/src/main.ts', b: 'C:/repo/src/helper.ts' } },
        { caller: '', files: { a: 'a.ts', b: 'other/b.ts' } },
        { caller: 'src/latest.ts', files: { a: 'src/contest.ts', b: 'tests/a.ts' } },
        { caller: 'src/main.ts', files: { a: 'tests/only.ts' } }
    ];
    let upstream;
    if (process.argv[2]) {
        const input = path.join(root, 'upstream-input.json');
        fs.writeFileSync(input, JSON.stringify(parityCases));
        upstream = JSON.parse(execFileSync(process.argv[2], [path.join(__dirname, 'graphify-optimization.py'), input], {
            encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 30000
        }));
        const { disambiguateCandidates } = require('../src/core/candidates.ts');
        const choices = parityCases.map(item => disambiguateCandidates(Object.entries(item.files).map(([id, filePath]) => ({ id, filePath })), item.caller)?.id || null);
        check(JSON.stringify(choices) === JSON.stringify(upstream.choices), `Graphify 후보 선택 차이: ${JSON.stringify({ choices, upstream: upstream.choices })}`);
        check(JSON.stringify(upstream.confidenceScores) === '[0.85]', 'Graphify의 전역 추론 신뢰도 규칙이 변경됨');
        check(JSON.stringify(upstream.pythonImportTargets) === JSON.stringify(['pkg/helpers.py', 'pkg/sub/helpers.py', 'pkg/__init__.py', null]),
            'Graphify Python 상대 임포트 규칙과 차이');
    }
    const buildTimings = {};
    for (const [name, modulePath] of [...(hasBaseline ? [['before', './optimization-before/src/core/build.ts']] : []), ['after', '../src/core/build.ts']]) {
        const directory = path.join(root, `project-${name}`);
        fs.mkdirSync(directory);
        fs.cpSync(path.join(project, 'src'), path.join(directory, 'src'), { recursive: true });
        fs.copyFileSync(path.join(project, 'tsconfig.json'), path.join(directory, 'tsconfig.json'));
        const { buildProjectIndex } = require(modulePath);
        const samples = [];
        for (let run = 0; run < 4; run++) {
            const start = performance.now();
            const built = await buildProjectIndex(directory, project);
            const elapsed = performance.now() - start;
            assert.equal(built.parseErrorFiles.length, 0);
            if (run === 0) buildTimings[name] = { coldMs: elapsed };
            else samples.push(elapsed);
        }
        samples.sort((a, b) => a - b);
        buildTimings[name].warmMedianMs = samples[1];
        buildTimings[name].samples = samples;
    }
    const result = { root, failures, timings, upstream, buildTimings };
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    assert.deepEqual(failures, []);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
