/** 배포와 같은 JavaScript 모듈로 AST·관계 해석·내부 JSON 저장 시간을 측정한다. */
const started = performance.now();
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [manifestPath, runtime, mode] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const { GraphIndex } = require(path.join(runtime, 'storage/index.js'));

/** 동일 파일 전체를 갱신하고 해석된 스냅샷과 실제 처리 수를 남긴다. */
async function main() {
    const index = new GraphIndex(manifest.root, manifest.project);
    const initStart = performance.now();
    await index.initialize(false);
    const initializationMs = performance.now() - initStart;
    const output = path.join(manifest.root, '.tools/.graphify/graph-cache.json');
    try {
        for (const phase of mode === 'restart' ? ['restart'] : ['cold', 'warm0', 'warm1', 'warm2', 'changed']) {
            if (phase === 'changed') fs.appendFileSync(path.join(manifest.root, manifest.files[0]), manifest.change);
            const begin = performance.now();
            for (const file of manifest.files) await index.updateFile(path.join(manifest.root, file), true);
            index.resolveRelations();
            await index.saveCache();
            const elapsedMs = performance.now() - begin;
            const data = index.getGraphData();
            assert.equal(index.getParseErrorFiles().length, 0, '문법 오류가 있으면 속도 비교를 중단한다.');
            assert(Object.keys(data.symbols).length > 0);
            if (['changed', 'restart'].includes(phase)) assert(Object.values(data.symbols).some(node => node.name === 'benchmark_added'));
            console.log(JSON.stringify({ phase, elapsedMs, initializationMs, readyMs: performance.now() - started,
                files: manifest.files.length, nodes: Object.keys(data.symbols).length,
                edges: Object.keys(data.relations).length, output }));
        }
    } finally { index.dispose(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
