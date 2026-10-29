const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

/** 배포 번들을 변경하지 않고 현재 TypeScript 소스를 검증한다. */
require.extensions['.ts'] = function compile(module, filename) {
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, filename);
};

/** 두 엔진을 같은 반례에 실행하고 사람이 확인한 정답 관계와 비교한다. */
async function main() {
    const root = fs.mkdtempSync(path.join(__dirname, 'review-'));
    const samples = {
        'typescript.ts': `class Store {
    get() {}
    set() {}
    resolve() {}
    save() {}
}
class Other { save() {} }
class Client {
    store: Store;
    runStore() {
        this.store.get();
        this.store.set();
        this.store.resolve();
        this.store.save();
        this.missing();
    }
}
class Stranger {
    store: Other;
    runOther() { this.store.save(); }
}
class Unrelated { missing() {} }
function runUnknown(store: any) { store.save(); }
function runTyped(store: Store) { store.get(); store.save(); }
function runChained() { new Store().get(); }
class ArrowClient {
    store: Store;
    runArrow = () => this.store.get();
}
`,
        'javascript.js': `class JsStore {
    get() {}
    resolve() {}
}
class JsClient {
    store = new JsStore();
    runJs() { this.store.get(); this.store.resolve(); }
}
`,
        'python.py': `class PyStore:
    def get(self): pass
    def set(self): pass
    def save(self): pass

class PyClient:
    def __init__(self):
        self.store = PyStore()
    def runPython(self):
        self.store.get()
        self.store.set()
        self.store.save()

def run_typed(store: PyStore):
    store.get()
    store.save()
`
    };
    const expected = [
        ['typescript.ts', 'Client::runStore', 'Store::get'],
        ['typescript.ts', 'Client::runStore', 'Store::set'],
        ['typescript.ts', 'Client::runStore', 'Store::resolve'],
        ['typescript.ts', 'Client::runStore', 'Store::save'],
        ['typescript.ts', 'Stranger::runOther', 'Other::save'],
        ['typescript.ts', 'runTyped', 'Store::get'],
        ['typescript.ts', 'runTyped', 'Store::save'],
        ['typescript.ts', 'runChained', 'Store::get'],
        ['typescript.ts', 'ArrowClient::runArrow', 'Store::get'],
        ['javascript.js', 'JsClient::runJs', 'JsStore::get'],
        ['javascript.js', 'JsClient::runJs', 'JsStore::resolve'],
        ['python.py', 'PyClient::runPython', 'PyStore::get'],
        ['python.py', 'PyClient::runPython', 'PyStore::set'],
        ['python.py', 'PyClient::runPython', 'PyStore::save'],
        ['python.py', 'run_typed', 'PyStore::get'],
        ['python.py', 'run_typed', 'PyStore::save']
    ];
    const forbidden = [
        ['typescript.ts', 'Client::runStore', 'Other::save'],
        ['typescript.ts', 'Client::runStore', 'Unrelated::missing'],
        ['typescript.ts', 'runUnknown', 'Other::save'],
        ['typescript.ts', 'runUnknown', 'Store::save']
    ];
    for (const name of ['graphify', 'lightweight']) {
        const directory = path.join(root, name);
        fs.mkdirSync(directory);
        for (const [file, code] of Object.entries(samples)) fs.writeFileSync(path.join(directory, file), code);
    }
    const python = process.argv[2];
    assert(python, '설치된 Graphify Python의 경로가 필요합니다.');
    execFileSync(python, [path.join(__dirname, 'graphify-review.py'), path.join(root, 'graphify')], {
        encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 120000
    });
    const { buildProjectIndex } = require('../src/core/build.ts');
    const built = await buildProjectIndex(path.join(root, 'lightweight'), path.resolve(__dirname, '..'));
    const lw = JSON.parse(fs.readFileSync(built.graphPath, 'utf8'));
    const gf = JSON.parse(fs.readFileSync(path.join(root, 'graphify/.tools/.graphify/graph.json'), 'utf8'));

    /** 서로 다른 엔진의 식별자를 각 엔진의 실제 규칙으로 비교한다. */
    function has(graph, item, engine) {
        const [file, source, target] = item;
        /** 심볼 경로를 해당 엔진의 식별자로 변환한다. */
        function id(symbol) {
            return engine === 'lightweight' ? `${file}::${symbol}`
                : `${path.parse(file).name}_${symbol.replaceAll('::', '_')}`.toLowerCase();
        }
        return (graph.links || graph.edges).some(edge => edge.relation === 'calls' && edge.source === id(source) && edge.target === id(target));
    }
    const result = {};
    for (const [engine, graph] of [['graphify', gf], ['lightweight', lw]]) {
        result[engine] = {
            nodes: graph.nodes.length,
            links: (graph.links || graph.edges).length,
            expected: expected.length,
            found: expected.filter(item => has(graph, item, engine)),
            missed: expected.filter(item => !has(graph, item, engine)),
            falseLinks: forbidden.filter(item => has(graph, item, engine))
        };
    }
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ root, result }, null, 2));
    assert.deepEqual({ missed: result.lightweight.missed, falseLinks: result.lightweight.falseLinks },
        { missed: [], falseLinks: [] }, '내장 메서드 동명 호출 누락·필드 타입 누출·다른 클래스 오연결을 막아야 한다.');

    if (process.argv.includes('--project')) {
        const snapshot = path.join(root, 'project');
        for (const engine of ['graphify', 'lightweight']) {
            const directory = path.join(snapshot, engine);
            fs.mkdirSync(directory, { recursive: true });
            fs.cpSync(path.join(__dirname, '../src'), path.join(directory, 'src'), { recursive: true });
            fs.copyFileSync(path.join(__dirname, '../tsconfig.json'), path.join(directory, 'tsconfig.json'));
        }
        execFileSync(python, [path.join(__dirname, 'graphify-review.py'), path.join(snapshot, 'graphify')], {
            encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 120000
        });
        await buildProjectIndex(path.join(snapshot, 'lightweight'), path.resolve(__dirname, '..'));
        const graphs = Object.fromEntries(['graphify', 'lightweight'].map(engine => [engine,
            JSON.parse(fs.readFileSync(path.join(snapshot, engine, '.tools/.graphify/graph.json'), 'utf8'))]));
        /** 파일·선언 시작 행·이름을 사용하여 실제 소스의 같은 심볼을 맞춘다. */
        function semanticPairs(graph) {
            const nodes = new Map(graph.nodes.map(node => [node.id, node]));
            /** 엔진마다 다른 ID 대신 원본 소스 위치로 비교한다. */
            function key(id) {
                const node = nodes.get(id);
                if (!node?.source_file || !node.source_location) return null;
                return `${node.source_file}:${node.source_location.match(/\d+/)?.[0]}:${node.label.replace(/^\./, '').replace(/\(\)$/, '')}`;
            }
            return new Set((graph.links || graph.edges).filter(edge => ['calls', 'references', 'inherits', 'implements'].includes(edge.relation))
                .flatMap(edge => key(edge.source) && key(edge.target) ? [`${key(edge.source)} --${edge.relation}--> ${key(edge.target)}`] : []));
        }
        const a = semanticPairs(graphs.graphify);
        const b = semanticPairs(graphs.lightweight);
        const comparison = {
            graphify: { nodes: graphs.graphify.nodes.length, edges: graphs.graphify.edges.length, semanticPairs: a.size },
            lightweight: { nodes: graphs.lightweight.nodes.length, edges: graphs.lightweight.links.length, semanticPairs: b.size },
            shared: [...a].filter(key => b.has(key)),
            graphifyOnly: [...a].filter(key => !b.has(key)),
            lightweightOnly: [...b].filter(key => !a.has(key))
        };
        fs.writeFileSync(path.join(root, 'project-result.json'), JSON.stringify(comparison, null, 2));
        console.log(`현재 소스 비교: ${JSON.stringify({ graphify: comparison.graphify, lightweight: comparison.lightweight, shared: comparison.shared.length })}`);
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
