const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Node와 Python 워커가 변경 후에도 바이트까지 동일한 입력을 남기는지 확인한다. */
function main() {
    const [benchmarkRoot, python] = process.argv.slice(2);
    const project = path.resolve(__dirname, '..');
    const root = fs.mkdtempSync(path.join(__dirname, 'performance-newline-'));
    const original = 'def entry(): pass\n';
    const change = '\ndef benchmark_added(): pass\n';
    for (const engine of ['lightweight', 'graphify']) {
        const directory = path.join(root, engine);
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'a.py'), original);
        const manifest = path.join(root, `${engine}.json`);
        fs.writeFileSync(manifest, JSON.stringify({ root: directory, project, files: ['a.py'], change }));
        const args = engine === 'lightweight'
            ? [path.join(__dirname, 'performance-worker.cjs'), manifest, path.resolve(benchmarkRoot, 'runtime'), 'normal']
            : [path.join(__dirname, 'performance-worker.py'), manifest, 'sequential', 'normal'];
        execFileSync(engine === 'lightweight' ? process.execPath : python, args, { env: { ...process.env, GRAPHIFY_OUT: '.tools/.graphify', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 30000 });
        assert.equal(fs.readFileSync(path.join(directory, 'a.py'), 'utf8'), original + change, `${engine} 워커의 줄바꿈 차이`);
    }
    console.log(`통과: 두 워커의 변경 후 입력 바이트 동일, ${root}`);
}
main();
