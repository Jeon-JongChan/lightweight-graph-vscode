const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { execFileSync } = require('node:child_process');

/** 배포 파일과 원본 입력을 변경하지 않고 현재 소스를 검사한다. */
require.extensions['.ts'] = function compile(module, filename) {
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, filename);
};

// §별칭:심볼명§은 선언 시작 행을 수작업 정답으로 지정하며 실제 파일을 쓸 때 제거한다.
const cases = [
    { name: 'js-function-expression', files: {
        'main.js': 'function helper() {} §helper:helper§\nconst entry = function() { helper(); }; §entry:entry§\n'
    }, required: [['entry', 'helper']] },
    { name: 'js-generator', files: {
        'main.js': 'function helper() {} §helper:helper§\nfunction* entry() { helper(); } §entry:entry§\n'
    }, required: [['entry', 'helper']] },
    { name: 'ts-default-import', files: {
        'lib.ts': 'export default function work() {} §work:work§\n',
        'main.ts': "import alias from './lib';\nfunction entry() { alias(); } §entry:entry§\n"
    }, required: [['entry', 'work']] },
    { name: 'ts-reexport-alias', files: {
        'lib.ts': 'export function work() {} §work:work§\n',
        'index.ts': "export { work as run } from './lib';\n",
        'main.ts': "import { run } from './index';\nfunction entry() { run(); } §entry:entry§\n"
    }, required: [['entry', 'work']] },
    { name: 'ts-default-expression', files: {
        'lib.ts': 'function work() {} §work:work§\nexport default work;\n',
        'main.ts': "import alias from './lib';\nfunction entry() { alias(); } §entry:entry§\n"
    }, required: [['entry', 'work']] },
    { name: 'ts-local-export-alias', files: {
        'lib.ts': 'function work() {} §work:work§\nexport { work as run };\n',
        'main.ts': "import { run } from './lib';\nfunction entry() { run(); } §entry:entry§\n"
    }, required: [['entry', 'work']] },
    { name: 'ts-star-namespace', files: {
        'lib.ts': 'export function work() {} §work:work§\n',
        'index.ts': "export * from './lib';\n",
        'main.ts': "import * as api from './index';\nfunction entry() { api.work(); } §entry:entry§\n"
    }, required: [['entry', 'work']] },
    { name: 'ts-star-ambiguity', files: {
        'a.ts': 'export function work() {} §first:work§\n',
        'b.ts': 'export function work() {} §second:work§\n',
        'index.ts': "export * from './a';\nexport * from './b';\n",
        'main.ts': "import { work } from './index';\nfunction entry() { work(); } §entry:entry§\n"
    }, required: [], forbidden: [['entry', 'first'], ['entry', 'second']] },
    { name: 'ts-import-alias', files: {
        'lib.ts': 'export function work() {} §work:work§\n',
        'main.ts': "import { work as alias } from './lib';\nfunction entry() { alias(); } §entry:entry§\n"
    }, required: [['entry', 'work']] },
    { name: 'ts-type-alias-import', files: {
        'lib.ts': 'export class Store { §store:Store§\n save() {} §save:save§\n}\n',
        'main.ts': "import { Store as Local } from './lib';\nfunction entry(store: Local) { store.save(); } §entry:entry§\n"
    }, required: [['entry', 'save']] },
    { name: 'ts-namespace-import', files: {
        'lib.ts': 'export function ping() {} §ping:ping§\n',
        'main.ts': "import * as api from './lib';\nfunction entry() { api.ping(); } §entry:entry§\n"
    }, required: [['entry', 'ping']] },
    { name: 'ts-local-shadow', files: {
        'lib.ts': 'export function work() {} §external:work§\n',
        'main.ts': "import { work as helper } from './lib';\nfunction entry() { §entry:entry§\n function helper() {} §local:helper§\n helper();\n}\n"
    }, required: [['entry', 'local']], forbidden: [['entry', 'external']] },
    { name: 'ts-parameter-shadow', files: {
        'main.ts': 'class Store { §store:Store§\n save() {} §save:save§\n}\nconst store = new Store();\nfunction entry(store: any) { store.save(); } §entry:entry§\n'
    }, required: [], forbidden: [['entry', 'save']] },
    { name: 'ts-constructor-nonfield', files: {
        'main.ts': 'class Store { §store:Store§\n save() {} §save:save§\n}\nclass Client {\n constructor(store: Store) {}\n entry() { this.store.save(); } §entry:entry§\n}\n'
    }, required: [], forbidden: [['entry', 'save']] },
    { name: 'ts-nested-receiver', files: {
        'main.ts': 'class Store { §store:Store§\n save() {} §save:save§\n}\nfunction outer(store: Store) {\n function entry() { store.save(); } §entry:entry§\n}\n'
    }, required: [['entry', 'save']] },
    { name: 'js-receiver-isolation', files: {
        'main.js': 'class Store {\n save() {} §save:save§\n}\nfunction entry(store) { store.save(); } §entry:entry§\n'
    }, required: [], forbidden: [['entry', 'save']] },
    { name: 'js-builtin-shadow', files: {
        'main.js': 'function resolve() {} §resolve:resolve§\nfunction entry() { resolve(); } §entry:entry§\n'
    }, required: [['entry', 'resolve']] },
    { name: 'python-import-alias', files: {
        'lib.py': 'def work(): pass §work:work§\n',
        'main.py': 'from lib import work as alias\ndef entry(): §entry:entry§\n    alias()\n'
    }, required: [['entry', 'work']] },
    { name: 'python-module-alias', files: {
        'lib.py': 'def work(): pass §work:work§\n',
        'main.py': 'import lib as api\ndef entry(): §entry:entry§\n    api.work()\n'
    }, required: [['entry', 'work']] },
    { name: 'python-parameter-shadow', files: {
        'main.py': 'class Store:\n    def save(self): pass §save:save§\nstore = Store()\ndef entry(store): §entry:entry§\n    store.save()\n'
    }, required: [], forbidden: [['entry', 'save']] },
    { name: 'python-nested-receiver', files: {
        'main.py': 'class Store:\n    def save(self): pass §save:save§\ndef outer(store: Store):\n    def entry(): §entry:entry§\n        store.save()\n'
    }, required: [['entry', 'save']] },
    { name: 'python-builtin-shadow', files: {
        'main.py': 'def open(): pass §open:open§\ndef entry(): §entry:entry§\n    open()\n'
    }, required: [['entry', 'open']] },
    { name: 'java-explicit-receiver', files: {
        'Main.java': 'class Other {\n void save() {} §other:save§\n}\nclass Client {\n void save() {} §own:save§\n void entry(Other other) { other.save(); } §entry:entry§\n}\n'
    }, required: [['entry', 'other']], forbidden: [['entry', 'own']] },
    { name: 'csharp-explicit-receiver', files: {
        'Main.cs': 'class Other {\n public void Save() {} §other:Save§\n}\nclass Client {\n public void Save() {} §own:Save§\n public void Entry(Other other) { other.Save(); } §entry:Entry§\n}\n'
    }, required: [['entry', 'other']], forbidden: [['entry', 'own']] },
    { name: 'cpp-explicit-receiver', files: {
        'main.cpp': 'class Other { public:\n void save() {} §other:save§\n};\nclass Client { public:\n void save() {} §own:save§\n void entry(Other& other) { other.save(); } §entry:entry§\n};\n'
    }, required: [['entry', 'other']], forbidden: [['entry', 'own']] },
    { name: 'ts-alias-parameter-shadow', files: {
        'lib.ts': 'export function work() {} §work:work§\n',
        'main.ts': "import { work as alias } from './lib';\nfunction entry(alias: any) { alias(); } §entry:entry§\n"
    }, required: [], forbidden: [['entry', 'work']] },
    { name: 'ts-namespace-parameter-shadow', files: {
        'lib.ts': 'export function ping() {} §ping:ping§\n',
        'main.ts': "import * as api from './lib';\nfunction entry(api: any) { api.ping(); } §entry:entry§\n"
    }, required: [], forbidden: [['entry', 'ping']] },
    { name: 'python-multiple-import-aliases', files: {
        'lib.py': 'def first(): pass §first:first§\ndef second(): pass §second:second§\n',
        'main.py': 'from lib import first as a\nfrom lib import second as b\ndef entry(): §entry:entry§\n    a()\n    b()\n'
    }, required: [['entry', 'first'], ['entry', 'second']] },
    { name: 'python-import-scope', files: {
        'lib.py': 'def work(): pass §work:work§\n',
        'main.py': 'def entry(): §entry:entry§\n    from lib import work as alias\n    alias()\ndef outside(): §outside:outside§\n    alias()\n'
    }, required: [['entry', 'work']], forbidden: [['outside', 'work']] },
    { name: 'python-builtin-not-imported', files: {
        'lib.py': 'def open(): pass §open:open§\n',
        'main.py': 'def entry(): §entry:entry§\n    open()\n'
    }, required: [], forbidden: [['entry', 'open']] },
    { name: 'python-default-parameter-shadow', files: {
        'main.py': 'class Store:\n    def save(self): pass §save:save§\nstore = Store()\ndef entry(store=None): §entry:entry§\n    store.save()\n'
    }, required: [], forbidden: [['entry', 'save']] },
    { name: 'python-local-value-shadow', files: {
        'main.py': 'class Store:\n    def save(self): pass §save:save§\nstore = Store()\ndef entry(): §entry:entry§\n    store = {}\n    store.save()\n'
    }, required: [], forbidden: [['entry', 'save']] },
    { name: 'js-default-parameter-shadow', files: {
        'main.js': 'class Store {\n save() {} §save:save§\n}\nconst store = new Store();\nfunction entry(store = {}) { store.save(); } §entry:entry§\n'
    }, required: [], forbidden: [['entry', 'save']] },
    { name: 'python-builtin-parameter-shadow', files: {
        'main.py': 'def open(): pass §open:open§\ndef entry(open): §entry:entry§\n    open()\n'
    }, required: [], forbidden: [['entry', 'open']] }
];

/** 파일·선언 시작 행·이름을 기준으로 서로 다른 식별자를 정답에 대응시킨다. */
function key(file, line, name) { return `${file.replaceAll('\\', '/')}:${line}:${name.replace(/^\./, '').replace(/\(\)$/, '')}`; }

/** 정답을 엔진에 독립적으로 유지하고 감시할 호출자의 재현율과 잘못된 확정 관계를 계산한다. */
function score(graph, anchors, sample) {
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    /** 출력 노드를 원본 선언 위치로 변환한다. */
    function nodeKey(id) {
        const node = nodes.get(id);
        const line = node?.source_location?.match(/\d+/)?.[0];
        return node?.source_file && line ? key(node.source_file, Number(line), node.label) : null;
    }
    const required = new Set(sample.required.map(([source, target]) => `${anchors[source]} -> ${anchors[target]}`));
    const allowed = new Set([...required, ...(sample.allowed || []).map(([source, target]) => `${anchors[source]} -> ${anchors[target]}`)]);
    const monitored = new Set([...sample.required, ...(sample.forbidden || [])].map(([source]) => anchors[source]));
    const found = new Set((graph.links || graph.edges).filter(edge => edge.relation === 'calls' && monitored.has(nodeKey(edge.source)) && nodeKey(edge.target))
        .map(edge => `${nodeKey(edge.source)} -> ${nodeKey(edge.target)}`));
    return { required: required.size, found: [...required].filter(pair => found.has(pair)).length,
        missed: [...required].filter(pair => !found.has(pair)), falseCalls: [...found].filter(pair => !allowed.has(pair)) };
}

/** 같은 반례를 분리된 프로젝트에서 실행해 사례 간 전역 후보 간섭을 막는다. */
async function main() {
    const python = process.argv[2];
    assert(python && fs.existsSync(python));
    const root = fs.mkdtempSync(path.join(__dirname, 'accuracy-'));
    const project = path.resolve(__dirname, '..');
    const { buildProjectIndex } = require('../src/core/build.ts');
    const result = { root, cases: [] };
    for (const sample of cases) {
        const anchors = {};
        const files = Object.fromEntries(Object.entries(sample.files).map(([file, code]) => [file, code.split('\n').map((line, index) => line.replace(/§([^:§]+):([^§]+)§/g,
            (_tag, alias, name) => { assert(!anchors[alias]); anchors[alias] = key(file, index + 1, name); return ''; })).join('\n')]));
        for (const pair of [...sample.required, ...(sample.forbidden || [])]) assert(pair.every(alias => anchors[alias]), `${sample.name}: 잘못된 정답 별칭`);
        const row = { name: sample.name };
        for (const engine of ['graphify', 'lightweight']) {
            const directory = path.join(root, sample.name, engine);
            fs.mkdirSync(directory, { recursive: true });
            for (const [file, code] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), code);
            if (engine === 'graphify') execFileSync(python, [path.join(__dirname, 'graphify-review.py'), directory], {
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', GRAPHIFY_OUT: '.tools/.graphify' }, encoding: 'utf8', timeout: 60000
            });
            else {
                const built = await buildProjectIndex(directory, project);
                assert.equal(built.parseErrorFiles.length, 0, `${sample.name}: 문법 오류`);
            }
            const graph = JSON.parse(fs.readFileSync(path.join(directory, '.tools/.graphify/graph.json'), 'utf8'));
            row[engine] = score(graph, anchors, sample);
        }
        result.cases.push(row);
        fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
        console.log(`${sample.name}: lightweight ${row.lightweight.found}/${row.lightweight.required}, 오연결 ${row.lightweight.falseCalls.length}; Graphify ${row.graphify.found}/${row.graphify.required}, 오연결 ${row.graphify.falseCalls.length}`);
    }
    result.summary = {};
    for (const engine of ['lightweight', 'graphify']) {
        const required = result.cases.reduce((sum, row) => sum + row[engine].required, 0);
        const truePositive = result.cases.reduce((sum, row) => sum + row[engine].found, 0);
        const falsePositive = result.cases.reduce((sum, row) => sum + row[engine].falseCalls.length, 0);
        result.summary[engine] = { required, truePositive, falsePositive, recall: truePositive / required,
            precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null };
    }
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(`정확도 결과: ${path.join(root, 'result.json')}`);
    if (process.argv.includes('--assert')) assert(result.cases.every(row => row.lightweight.missed.length === 0 && row.lightweight.falseCalls.length === 0), '정확도 반례가 남았다.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
