const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

/** 한 파일씩 읽고 정렬하여 순회와 파일 선택을 두 엔진에서 일치시킨다. */
function sourceFiles(directory, prefix = '') {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') return sourceFiles(path.join(directory, entry.name), relative);
        return entry.isFile() && /\.(ts|tsx|js|py)$/.test(entry.name) ? [relative.replaceAll('\\', '/')] : [];
    }).sort();
}

/** 고유 이름과 명시적 교차 파일 호출·타입 수신자·상속 정답을 가진 혼합 입력을 만든다. */
function mixed(count) {
    const files = {};
    const expected = [];
    for (let n = 0; n < count; n++) {
        const next = (n + 3) % count;
        const ext = ['ts', 'js', 'py'][n % 3];
        const stem = `unit${n}`;
        const file = `${stem}.${ext}`;
        const annotation = ext === 'ts' ? `: Repo${n}` : '';
        files[file] = ext === 'py'
            ? `from unit${next} import helper${next}\ndef helper${n}(): pass\ndef entry${n}():\n    helper${n}()\n    helper${next}()\nclass Repo${n}:\n    def get(self): pass\ndef typed${n}(store: Repo${n}):\n    store.get()\nclass Child${n}(Repo${n}):\n    def run(self):\n        self.get()\n`
            : `import { helper${next} } from './unit${next}';\nexport function helper${n}() {}\nexport function entry${n}() { helper${n}(); helper${next}(); }\nclass Repo${n} { get() {} }\nfunction typed${n}(${ext === 'js' ? '' : `store${annotation}`}) { ${ext === 'js' ? `const store = new Repo${n}();` : ''} store.get(); }\nclass Child${n} extends Repo${n} { run() { this.get(); } }\n`;
        expected.push([file, `entry${n}`, file, `helper${n}`],
            [file, `entry${n}`, `unit${next}.${ext}`, `helper${next}`],
            [file, `typed${n}`, file, `Repo${n}::get`],
            [file, `Child${n}::run`, file, `Repo${n}::get`]);
    }
    return { files, expected };
}

/** 워커가 첫 결과를 실제로 전달할 때까지의 프로세스 시작 포함 시간을 기록한다. */
function run(command, args) {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        const child = spawn(command, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', GRAPHIFY_OUT: '.tools/.graphify' }, windowsHide: true });
        const rows = [];
        const diagnostics = [];
        let pending = '', stderr = '';
        const timeout = setTimeout(() => { child.kill(); reject(new Error('워커 180초 제한 초과')); }, 180000);
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
        child.stdout.on('data', chunk => {
            pending += chunk;
            const lines = pending.split('\n'); pending = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('{')) { diagnostics.push(line); continue; }
                try {
                    const row = JSON.parse(line);
                    if (rows.length === 0) row.wallToFirstResultMs = performance.now() - start;
                    rows.push(row);
                } catch (error) { child.kill(); reject(error); }
            }
        });
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('close', code => {
            clearTimeout(timeout);
            if (code !== 0 || !rows.length) reject(new Error(`워커 실패 ${code}: ${stderr}`));
            else { rows.diagnostics = { stdout: diagnostics.join('\n'), stderr }; resolve(rows); }
        });
    });
}

/** 엔진 고유 식별자를 정답 심볼 경로와 맞춰 실제 호출 누락을 센다. */
function quality(output, engine, root, expected) {
    const graph = JSON.parse(fs.readFileSync(output, 'utf8'));
    const links = engine === 'lightweight' ? Object.values(graph.relations).filter(edge => edge.kind === 'call') : graph.edges.filter(edge => edge.relation === 'calls');
    const pairs = new Set(links.map(edge => engine === 'lightweight' ? `${edge.sourceId}\n${edge.targetId}` : `${edge.source}\n${edge.target}`));
    /** 심볼 경로를 엔진 고유 ID로 바꾼다. */
    function id(file, symbol) {
        return engine === 'lightweight' ? `${path.join(root, file)}::${symbol}` : `${path.parse(file).name}_${symbol.replaceAll('::', '_')}`.toLowerCase();
    }
    const missed = expected.filter(([file, source, targetFile, target]) => !pairs.has(`${id(file, source)}\n${id(targetFile, target)}`));
    return { expected: expected.length, found: expected.length - missed.length, missed };
}

/** 정렬한 표본의 중앙값과 범위를 반환한다. */
function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), samples: values };
}

/** 서로 다른 실제 입력과 합성 입력을 5개 독립 블록에서 순서를 교차하여 측정한다. */
async function main() {
    const python = process.argv[2];
    assert(python && fs.existsSync(python), 'Graphify Python 경로가 필요하다.');
    const project = path.resolve(__dirname, '..');
    const root = fs.mkdtempSync(path.join(__dirname, 'performance-'));
    const runtime = path.join(root, 'runtime');
    execFileSync(process.execPath, [path.join(project, 'node_modules/typescript/bin/tsc'), '--project', path.join(project, 'tsconfig.json'), '--outDir', runtime, '--sourceMap', 'false'], { cwd: project, stdio: 'pipe' });
    const actual = {};
    for (const [name, directory] of [['engine-src', path.join(project, 'src')], ['native-sound', path.resolve(project, '../NativeSound')]]) {
        actual[name] = { files: Object.fromEntries(sourceFiles(directory).map(file => [file, fs.readFileSync(path.join(directory, file), 'utf8')])), expected: [] };
    }
    const pythonCorpus = mixed(900);
    const pythonWorkload = { files: Object.fromEntries(Object.entries(pythonCorpus.files).filter(([file]) => file.endsWith('.py'))),
        expected: pythonCorpus.expected.filter(([file]) => file.endsWith('.py')) };
    const workloads = process.argv.includes('--python-only') ? { 'python-300': pythonWorkload }
        : process.argv.includes('--large-only') ? { 'mixed-300': mixed(300), 'python-300': pythonWorkload }
        : { ...actual, 'mixed-30': mixed(30), 'mixed-300': mixed(300) };
    const records = [];
    const result = { root, environment: { node: process.version, platform: process.platform, release: os.release(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, trials: 5, warmPerTrial: 3 }, workloads: {}, records };
    const engines = ['lightweight', 'graphify-sequential', 'graphify-parallel4'];
    for (const [name, workload] of Object.entries(workloads)) {
        const files = Object.keys(workload.files).sort();
        assert(files.length > 0);
        result.workloads[name] = { files: files.length, bytes: Object.values(workload.files).reduce((n, code) => n + Buffer.byteLength(code), 0),
            sha256: crypto.createHash('sha256').update(JSON.stringify(workload.files)).digest('hex'), expected: workload.expected.length };
        for (let trial = 0; trial < 5; trial++) {
            const order = [...engines.slice(trial % 3), ...engines.slice(0, trial % 3)];
            for (const engine of order) {
                const directory = path.join(root, name, String(trial), engine);
                for (const [file, code] of Object.entries(workload.files)) {
                    const target = path.join(directory, file);
                    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, code);
                }
                const change = files[0].endsWith('.py') ? '\ndef benchmark_added(): pass\n' : '\nfunction benchmark_added() {}\n';
                const manifest = path.join(root, `${name}-${trial}-${engine}.json`);
                fs.writeFileSync(manifest, JSON.stringify({ root: directory, project, files, change }));
                const command = engine === 'lightweight' ? process.execPath : python;
                const args = engine === 'lightweight' ? [path.join(__dirname, 'performance-worker.cjs'), manifest, runtime] : [path.join(__dirname, 'performance-worker.py'), manifest, engine.endsWith('parallel4') ? 'parallel' : 'sequential'];
                const rows = await run(command, [...args, 'normal']);
                assert.deepEqual(rows.map(row => row.phase), ['cold', 'warm0', 'warm1', 'warm2', 'changed']);
                const accuracy = quality(rows.at(-1).output, engine === 'lightweight' ? engine : 'graphify', directory, workload.expected);
                const restarted = await run(command, [...args, 'restart']);
                assert.equal(restarted[0].nodes, rows.at(-1).nodes, '재시작 후 노드 수 변화');
                assert.equal(restarted[0].edges, rows.at(-1).edges, '재시작 후 관계 수 변화');
                records.push({ workload: name, trial, engine, rows: [...rows, ...restarted], quality: accuracy,
                    diagnostics: { normal: rows.diagnostics, restart: restarted.diagnostics } });
                fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
                console.log(`${name} ${trial + 1}/5 ${engine}: 첫 결과 ${rows[0].wallToFirstResultMs.toFixed(0)}ms, 호출 ${accuracy.found}/${accuracy.expected}`);
            }
        }
    }
    result.summary = {};
    for (const name of Object.keys(workloads)) {
        result.summary[name] = {};
        for (const engine of engines) {
            const blocks = records.filter(record => record.workload === name && record.engine === engine);
            const groups = {};
            for (const phase of ['cold', 'warm', 'changed', 'restart']) {
                groups[phase] = stats(blocks.map(block => {
                    const rows = block.rows.filter(row => phase === 'warm' ? row.phase.startsWith('warm') : row.phase === phase);
                    return stats(rows.map(row => ['cold', 'restart'].includes(phase) ? row.wallToFirstResultMs : row.elapsedMs)).medianMs;
                }));
            }
            result.summary[name][engine] = { ...groups, quality: blocks[0].quality };
        }
    }
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(`최종 결과: ${path.join(root, 'result.json')}`);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
