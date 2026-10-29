const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

/** 실행 결과·입력 동일성·합성 호출 정답·캐시 재시작의 일관성을 다시 검사한다. */
function main() {
    const root = path.resolve(process.argv[2]);
    const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
    assert(result.summary, '전체 측정이 끝난 결과만 감사한다.');
    assert.equal(result.records.length, Object.keys(result.workloads).length * 5 * 3);
    const inputs = new Map();
    const changeNewlines = {};
    const accuracy = {};
    const comparisons = {};
    for (const record of result.records) {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, `${record.workload}-${record.trial}-${record.engine}.json`), 'utf8'));
        const sources = manifest.files.map((file, index) => {
            const text = fs.readFileSync(path.join(manifest.root, file), 'utf8');
            if (index !== 0) return [file, text];
            // Windows Python의 기본 텍스트 출력은 추가분만 CRLF로 바꿀 수 있어 원본 해시와 별도로 기록한다.
            const suffix = text.endsWith(manifest.change) ? manifest.change : manifest.change.replaceAll('\n', '\r\n');
            assert(text.endsWith(suffix), '변경 표식이 사라졌다.');
            changeNewlines[`${record.workload}/${record.trial}/${record.engine}`] = suffix === manifest.change ? 'LF' : 'CRLF';
            return [file, text.slice(0, -suffix.length)];
        });
        const digest = crypto.createHash('sha256').update(JSON.stringify(sources)).digest('hex');
        if (inputs.has(record.workload)) assert.equal(digest, inputs.get(record.workload), '엔진/반복 간 원본 입력 차이');
        else inputs.set(record.workload, digest);
        const graph = JSON.parse(fs.readFileSync(record.rows.at(-1).output, 'utf8'));
        const represented = new Set(record.engine === 'lightweight'
            ? Object.values(graph.symbols).map(node => path.relative(manifest.root, node.filePath).replaceAll('\\', '/'))
            : graph.nodes.map(node => node.source_file?.replaceAll('\\', '/')));
        assert(manifest.files.every(file => represented.has(file)), '입력 파일이 최종 그래프에서 통째로 누락됐다.');
        if (record.workload.startsWith('mixed-') || record.workload === 'python-300') {
            const count = record.workload === 'python-300' ? manifest.files.length * 3 : manifest.files.length;
            const allowed = new Set();
            const expected = new Set();
            /** 공통 파일명과 심볼 경로를 실제 엔진 ID로 변환한다. */
            function id(n, symbol) {
                const ext = ['ts', 'js', 'py'][n % 3];
                return record.engine === 'lightweight' ? `${path.join(manifest.root, `unit${n}.${ext}`)}::${symbol}` : `unit${n}_${symbol.replaceAll('::', '_')}`.toLowerCase();
            }
            for (let n = 0; n < count; n++) {
                if (record.workload === 'python-300' && n % 3 !== 2) continue;
                for (const [source, targetN, target] of [[`entry${n}`, n, `helper${n}`], [`entry${n}`, (n + 3) % count, `helper${(n + 3) % count}`],
                    [`typed${n}`, n, `Repo${n}::get`], [`Child${n}::run`, n, `Repo${n}::get`]]) {
                    const pair = `${id(n, source)}\n${id(targetN, target)}`;
                    expected.add(pair); allowed.add(pair);
                }
                // JS의 지역 new 할당도 정답 호출이며 수신자 추론 입력을 만든다.
                if (n % 3 === 1) allowed.add(`${id(n, `typed${n}`)}\n${id(n, `Repo${n}`)}`);
            }
            const calls = record.engine === 'lightweight'
                ? Object.values(graph.relations).filter(edge => edge.kind === 'call').map(edge => [edge.sourceId, edge.targetId])
                : graph.edges.filter(edge => edge.relation === 'calls').map(edge => [edge.source, edge.target]);
            const pairs = new Set(calls.map(pair => pair.join('\n')));
            const missed = [...expected].filter(pair => !pairs.has(pair));
            const falseCalls = [...pairs].filter(pair => !allowed.has(pair));
            assert.equal(missed.length, record.quality.missed.length, '두 독립 정답 비교의 누락 수 차이');
            const key = `${record.workload}/${record.engine}`;
            if (accuracy[key]) {
                assert.equal(accuracy[key].found, expected.size - missed.length, '반복 간 호출 재현율 변화');
                assert.equal(accuracy[key].falseCalls, falseCalls.length, '반복 간 오연결 수 변화');
            }
            accuracy[key] = { expected: expected.size, found: expected.size - missed.length, falseCalls: falseCalls.length, missed, falsePairs: falseCalls };
        }
        assert(record.rows.every(row => row.files === manifest.files.length && row.elapsedMs > 0), '처리 파일 수/측정값 오류');
        assert.equal(record.rows[0].nodes + 1, record.rows.at(-1).nodes, '실제 소스 변경의 새 심볼이 정확히 하나 반영돼야 한다.');
        if (record.workload === 'python-300' && record.engine !== 'lightweight') {
            const diagnostics = record.diagnostics;
            assert.equal((diagnostics.normal.stdout.match(/AST cache: 300\/300 files served from cache \(100%\); 0 to extract/g) || []).length, 3,
                'Python 반복 실행에서 Graphify 디스크 캐시가 적용돼야 한다.');
            assert(diagnostics.normal.stdout.includes('299/300 files served from cache'), '파일 하나만 변경된 캐시 상태여야 한다.');
            assert(diagnostics.restart.stdout.includes('300/300 files served from cache'), '프로세스 재시작 후 디스크 캐시가 적용돼야 한다.');
            if (record.engine === 'graphify-parallel4') assert(diagnostics.normal.stdout.includes('[4 workers]'), '실제 병렬 추출 기록이 없다.');
            assert(!/falling back|worker failed/.test(diagnostics.normal.stdout + diagnostics.normal.stderr), '병렬 실패를 정상 병렬 측정으로 표시하면 안 된다.');
        }
    }
    for (const [workload, engines] of Object.entries(result.summary)) {
        comparisons[workload] = {};
        for (const phase of ['cold', 'warm', 'changed', 'restart']) {
            const lw = engines.lightweight[phase];
            const best = ['graphify-sequential', 'graphify-parallel4'].sort((a, b) => engines[a][phase].medianMs - engines[b][phase].medianMs)[0];
            const gf = engines[best][phase];
            const ratios = lw.samples.map((value, index) => Math.min(engines['graphify-sequential'][phase].samples[index], engines['graphify-parallel4'][phase].samples[index]) / value);
            comparisons[workload][phase] = { lightweightMs: lw.medianMs, graphifyMs: gf.medianMs, bestGraphify: best,
                speedup: gf.medianMs / lw.medianMs, pairedRatiosAgainstFasterGraphify: ratios,
                decision: ratios.every(ratio => ratio > 1.1) ? '모든 블록에서 lightweight 10% 이상 빠름' : ratios.every(ratio => ratio >= 0.9 && ratio <= 1.1) ? '모든 블록에서 ±10% 범위' : '10% 우세·±10% 동등 기준 미충족' };
        }
    }
    const project = path.resolve(__dirname, '..');
    const sourceHashes = Object.fromEntries(fs.readdirSync(path.join(project, 'src'), { recursive: true }).filter(file => /\.(ts|json)$/.test(file))
        .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(project, 'src', file))).digest('hex')]));
    const environment = { ...result.environment, sourceHashes, typescriptVersion: require('typescript/package.json').version };
    if (process.argv.includes('--verify-current')) {
        const directory = fs.mkdtempSync(path.join(root, 'runtime-verify-'));
        execFileSync(process.execPath, [path.join(project, 'node_modules/typescript/bin/tsc'), '--project', path.join(project, 'tsconfig.json'), '--outDir', directory, '--sourceMap', 'false'],
            { cwd: project, stdio: 'pipe', timeout: 30000 });
        const files = fs.readdirSync(path.join(root, 'runtime'), { recursive: true }).filter(file => /\.(js|json)$/.test(file));
        assert.deepEqual([...files].sort(), fs.readdirSync(directory, { recursive: true }).filter(file => /\.(js|json)$/.test(file)).sort(), '컴파일 파일 집합 차이');
        for (const file of files) assert(fs.readFileSync(path.join(root, 'runtime', file)).equals(fs.readFileSync(path.join(directory, file))),
            `측정 런타임과 최종 소스의 컴파일 결과 차이: ${file}`);
        environment.currentRuntimeVerifiedFiles = files.length;
    }
    if (process.argv[3]) {
        const script = "import sys,json,hashlib,inspect,importlib.metadata as m;import graphify.extract as e;import graphify.symbol_resolution as s;print(json.dumps({'python':sys.version,'packages':{d.metadata['Name']:d.version for d in m.distributions() if d.metadata['Name'].lower().startswith(('graphify','tree-sitter'))},'sourceHashes':{inspect.getfile(x):hashlib.sha256(open(inspect.getfile(x),'rb').read()).hexdigest() for x in [e,s]}}))";
        environment.graphify = JSON.parse(execFileSync(process.argv[3], ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 30000 }));
    }
    const audit = { environment, inputs: Object.fromEntries(inputs), changeNewlines, accuracy, comparisons };
    fs.writeFileSync(path.join(root, 'audit.json'), JSON.stringify(audit, null, 2));
    console.log(JSON.stringify({ comparisons, accuracy: Object.fromEntries(Object.entries(accuracy).map(([key, value]) => [key, { expected: value.expected, found: value.found, falseCalls: value.falseCalls }])) }, null, 2));
}
main();
