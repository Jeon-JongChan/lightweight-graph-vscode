const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// 테스트 전용 로더로 소스를 실행하므로 검증 때문에 배포 번들을 덮어쓰지 않는다.
require.extensions['.ts'] = function compile(module, filename) {
    /** 테스트 실행에 필요한 TypeScript만 메모리에서 변환한다. */
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true }
    });
    module._compile(compiled.outputText, filename);
};

/** 언어별 실제 WASM, 생성 동시성, 캐시 보존, UI 연결을 한 흐름으로 검증한다. */
async function main() {
    const project = path.resolve(__dirname, '..');
    const root = fs.mkdtempSync(path.join(__dirname, 'run-'));
    const samples = require('./languages.json');
    for (const sample of samples) fs.writeFileSync(path.join(root, sample.file), sample.code);
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '// JSONC tsconfig\n{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["./*"] },\n  },\n}\n');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'function mustNotAppear() {}');
    const { buildProjectIndex, withIndexLock } = require('../src/core/build.ts');
    const { GraphCache } = require('../src/storage/cache.ts');
    const cache = new GraphCache(root);
    const built = await buildProjectIndex(root, project);
    const data = await cache.load();
    for (const sample of samples) {
        const file = path.join(root, sample.file);
        const symbols = Object.values(data.symbols).filter(symbol => symbol.filePath === file);
        for (const name of sample.symbols) assert(symbols.some(symbol => symbol.name === name), `${sample.file}: ${name} 심볼 누락`);
        const relations = Object.values(data.relations).filter(relation => relation.id.startsWith(file));
        assert(relations.some(relation => relation.kind === 'call' && relation.targetId.endsWith('::helper')), `${sample.file}: 호출 누락`);
        if (sample.file !== 'Sample.cs') {
            assert(relations.some(relation => relation.kind === 'call' && relation.targetId.endsWith('::helper') && data.symbols[relation.targetId]),
                `${sample.file}: 실제 helper 정의로 해석되지 않은 호출`);
        }
        if (sample.import) assert(relations.some(relation => relation.kind === 'import'), `${sample.file}: 임포트 누락`);
        if (sample.inherit) assert(relations.some(relation => relation.kind === 'inherit'), `${sample.file}: 상속 누락`);
        assert(relations.filter(relation => relation.kind === 'call').some(relation => data.symbols[relation.sourceId]), `${sample.file}: 호출자 심볼 연결 누락`);
    }
    assert.equal(built.filesIndexed, samples.length);
    assert(Object.values(data.relations).some(rel => rel.sourceId.endsWith('Sample.java::Service::run') && rel.targetId.endsWith('Sample.java::Base::inherited') && rel.certainty === 'RESOLVED'),
        'Java의 암묵적 this 호출은 상속받은 메서드도 해석해야 한다.');
    assert(built.parseErrorFiles.some(file => file.endsWith('sample.cu')));
    assert(built.parseErrorFiles.some(file => file.endsWith('sample.mm')));
    assert(!Object.values(data.symbols).some(symbol => symbol.name === 'mustNotAppear'));
    assert(!Object.values(data.symbols).some(symbol => symbol.name === 'localOnly'), '함수 내부 지역 변수가 심볼 노드로 추출되면 안 된다.');
    assert(Object.values(data.relations).some(rel => rel.sourceId.endsWith('::Service::run') && rel.kind === 'call' && rel.targetId.endsWith('::Base')), 'TS/JS의 new ClassName() 생성자 호출이 추출·해석되어야 한다.');
    assert(Object.values(data.relations).some(rel => rel.sourceId.endsWith('::Service::run') && rel.kind === 'reference' && rel.targetId.endsWith('::Work')), 'TS의 타입 참조(w: Work)가 reference 관계로 추출·해석되어야 한다.');
    assert(Object.values(data.relations).some(rel => rel.sourceId === path.join(root, 'sample.ts') && rel.kind === 'import' && rel.targetId === path.join(root, 'sample.tsx') && rel.certainty === 'RESOLVED'), 'tsconfig paths 별칭(@/*) 임포트가 실제 파일로 해석되어야 한다.');
    assert(Object.values(data.relations).some(rel => rel.sourceId.endsWith('::Service::run') && rel.kind === 'call' && rel.targetId.endsWith('::RepoStore::save')), '클래스 필드 타입 추론(this.store = new RepoStore())으로 멤버 호출이 해석되어야 한다.');
    assert(Object.values(data.relations).some(rel => rel.sourceId.endsWith('::Service::run') && rel.kind === 'call' && rel.targetId.endsWith('::Base::basePing')), '상속받은 부모 클래스 메서드 호출(this.basePing())이 Base::basePing으로 해석되어야 한다.');
    assert(Object.values(data.relations).some(rel => rel.sourceId.endsWith('sample.py::Service::run') && rel.kind === 'reference' && rel.targetId.endsWith('sample.py::Base')), 'Python 타입 어노테이션 참조(b: Base -> Base)가 추출·해석되어야 한다.');
    const csharpCall = Object.values(data.relations).find(relation => relation.id.startsWith(path.join(root, 'Sample.cs')) && relation.kind === 'call' && relation.targetId.endsWith('::helper'));
    assert.equal(csharpCall.targetId, 'unknown::helper', '다른 언어의 동명 함수를 잘못 연결하면 안 된다.');
    assert(Object.values(data.relations).some(relation => relation.sourceId.endsWith('Sample.cs::App::Service::Run') && relation.targetId.endsWith('::App::Service::Helper')),
        'C#의 동일 클래스 메서드 호출은 대소문자를 구분해 해석해야 한다.');
    const graph = JSON.parse(fs.readFileSync(built.graphPath, 'utf8'));
    const ids = new Set(graph.nodes.map(node => node.id));
    assert(graph.links.every(link => ids.has(link.source) && ids.has(link.target)));
    assert(graph.nodes.every(node => !node.id.includes(root)));
    assert(graph.links.every(link => !link.key.includes(root) && !link.source.includes(root) && !link.target.includes(root)), '링크 키에 호스트 절대 경로가 남아 있으면 안 된다.');
    assert.equal(graph.graph.producer, 'lightweight-graph-mcp');
    assert(!('graphify_version' in graph.graph));
    assert(Array.isArray(graph.hyperedges));
    assert(graph.nodes.some(node => node.kind === 'file' && node.file_type === 'code'), '파일 수준 노드가 포함되어야 한다.');
    assert(graph.nodes.every(node => typeof node.norm_label === 'string' && typeof node.community === 'number' && typeof node.community_name === 'string'), '노드에 정규화 라벨과 커뮤니티 정보가 있어야 한다.');
    assert(graph.links.some(link => link.relation === 'contains'), '파일-심볼 포함(contains) 관계가 있어야 한다.');
    assert(graph.links.some(link => link.relation === 'method'), '클래스-메서드(method) 관계가 있어야 한다.');
    assert(graph.links.every(link => typeof link.confidence_score === 'number' && link.confidence_score > 0 && link.confidence_score <= 1), '모든 링크에 신뢰도 점수가 있어야 한다.');
    assert(built.htmlPath && fs.existsSync(built.htmlPath), '시각화 HTML(graph.html)이 생성되어야 한다.');
    const reportText = fs.readFileSync(built.reportPath, 'utf8');
    for (const heading of ['## 요약', '## 핵심 추상화 (God Nodes)', '## 의외의 연결 (Surprising Connections)', '## 커뮤니티 (Communities)', '## 확인이 필요한 관계 (Ambiguous Edges)', '## 지식 공백 (Knowledge Gaps)', '## 추천 질문 (Suggested Questions)']) {
        assert(reportText.includes(heading), `리포트 섹션 누락: ${heading}`);
    }
    const { GraphTools } = require('../src/mcp/tools.ts');
    const tools = new GraphTools(() => data);
    assert(tools.getGodNodes(5).length > 0, '핵심 노드 조회 결과가 있어야 한다.');
    assert(tools.getCommunities().communities.length > 0, '커뮤니티 목록이 있어야 한다.');
    assert(tools.queryGraph('어떻게 Service run 동작', 'bfs', 2, 10).nodes.length > 0, '한국어 질문 불용어가 제거되고 서브그래프 탐색 결과가 있어야 한다.');
    assert(tools.getImpact('Work').some(sym => sym.name === 'run'), '인터페이스(Work)의 변경 영향도에 타입 참조 심볼(run)이 포함되어야 한다.');
    assert(tools.getImpact('RepoStore').some(sym => sym.name === 'run'), '클래스(RepoStore) 변경 영향도에 소속 메서드(save)의 호출자(run)가 포함되어야 한다.');
    const sp = tools.findShortestPath('sample.ts::Service::run', 'sample.ts::RepoStore::save');
    assert(sp.found && sp.hops === 1, '심볼 간 최단 경로는 파일 contains 우회 대신 직접 호출(1 hop)을 우선해야 한다.');
    const before = fs.readFileSync(cache.getCachePath(), 'utf8');
    await withIndexLock(root, async () => {
        await assert.rejects(buildProjectIndex(root, project), /이미 그래프/);
    });
    assert.equal(fs.readFileSync(cache.getCachePath(), 'utf8'), before);
    await assert.rejects(buildProjectIndex(root, path.join(root, 'missing-extension')));
    assert.equal(fs.readFileSync(cache.getCachePath(), 'utf8'), before);
    assert(!fs.existsSync(path.join(path.dirname(cache.getCachePath()), 'index.lock')));
    fs.writeFileSync(path.join(root, 'sample.js'), 'function changed() {}');
    await buildProjectIndex(root, project);
    const updated = await cache.load();
    assert(!updated.symbols[`${path.join(root, 'sample.js')}::run`]);
    assert(updated.symbols[`${path.join(root, 'sample.js')}::changed`]);

    // Graphify Watch 방식의 실시간 감시·디바운스 자동 갱신을 검증한다.
    const { ProjectWatcher } = require('../src/core/build.ts');
    const watcher = new ProjectWatcher(root, project, { debounceMs: 80 });
    watcher.start();
    try {
        watcher.notifyFileChanged(path.join(root, 'sample.js'));
        fs.writeFileSync(path.join(root, 'sample.js'), 'function watchedSymbol() {}');
        watcher.notifyFileChanged(path.join(root, 'sample.js'));
        await watcher.waitForIdle();
        const watchedData = await cache.load();
        assert(watchedData.symbols[`${path.join(root, 'sample.js')}::watchedSymbol`], 'Watch 모드가 변경된 파일을 감지해 그래프를 자동 갱신해야 한다.');
    } finally {
        watcher.stop();
    }

    const commands = new Map();
    const executed = [];
    const statusBar = { show() {}, dispose() {} };
    const disposable = { dispose() {} };
    let selection = 1;
    let provider;
    const vscode = {
        StatusBarAlignment: { Right: 1 },
        window: {
            createStatusBarItem: () => statusBar,
            showQuickPick: async items => items[selection],
            showErrorMessage: message => { throw new Error(message); },
            showWarningMessage: async () => undefined,
            showInformationMessage: () => undefined
        },
        workspace: {
            isTrusted: true,
            workspaceFolders: [{ name: '대상', uri: { scheme: 'file', fsPath: root } }],
            onDidChangeWorkspaceFolders: () => disposable,
            onDidGrantWorkspaceTrust: () => disposable
        },
        commands: {
            registerCommand: (name, command) => { commands.set(name, command); return disposable; },
            executeCommand: async name => { executed.push(name); return commands.get(name)?.(); }
        },
        extensions: { getExtension: () => ({}) },
        lm: { registerMcpServerDefinitionProvider: (id, value) => { provider = value; return disposable; } },
        EventEmitter: class {
            /** 테스트 이벤트 구독을 대신한다. */
            constructor() { this.event = () => disposable; }
            /** 이벤트 발생을 대신한다. */
            fire() {}
            /** 이벤트 자원을 대신 해제한다. */
            dispose() {}
        },
        McpStdioServerDefinition: class {
            /** 실제 API와 같은 인수로 서버 정의를 보관한다. */
            constructor(label, command, args, env) { Object.assign(this, { label, command, args, env }); }
        }
    };
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
    };
    try {
        const manifest = require('../package.json');
        assert.equal(manifest.contributes.mcpServerDefinitionProviders[0].id, 'lightweight-graph-mcp');
        require('../src/extension/extension.ts').activate({ extensionPath: project, subscriptions: [] });
        assert.equal(statusBar.command, 'graph-mcp.quickActions');
        await commands.get('graph-mcp.quickActions')();
        assert(executed.includes('workbench.mcp.listServer'));
        selection = 0;
        // 생성 메뉴가 공유 생성 명령으로 연결되는지만 UI에서 확인한다.
        commands.set('graph-mcp.buildIndex', async () => undefined);
        await commands.get('graph-mcp.quickActions')();
        assert(executed.includes('graph-mcp.buildIndex'));
        assert(commands.has('graph-mcp.toggleWatch'), '실시간 감시(Watch) 토글 명령이 등록되어야 한다.');
        await commands.get('graph-mcp.toggleWatch')();
        assert(statusBar.text.includes('감시 중'), 'Watch 시작 시 상태표시줄에 감시 중이 표시되어야 한다.');
        await commands.get('graph-mcp.toggleWatch')();
        assert(!statusBar.text.includes('감시 중'), 'Watch 중지 시 상태표시줄이 기본 상태로 복귀해야 한다.');
        const definitions = provider.provideMcpServerDefinitions();
        assert.equal(definitions.length, 1);
        assert.equal(definitions[0].args[1], root);
        vscode.workspace.isTrusted = false;
        assert.equal(provider.provideMcpServerDefinitions().length, 0);
        provider.dispose();
    } finally { Module._load = originalLoad; }
    console.log(`통과: ${samples.length}개 언어·방언 샘플, 내보내기, 잠금, 실패 보존, 재생성, 퀵 메뉴 및 MCP 등록`);
    console.log(`검증 산출물: ${root}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
