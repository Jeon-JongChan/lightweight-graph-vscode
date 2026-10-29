const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pack } = require('@vscode/vsce/out/package');

/** 기존 임시 폴더의 권한에 영향받지 않도록 배포 파일만 새 위치에 복사해 패키징한다. */
async function main() {
    const project = path.resolve(__dirname, '..');
    const stage = fs.mkdtempSync(path.join(__dirname, 'package-stage-'));
    const packagePath = path.join(project, 'lightweight-graph-mcp-1.2.0-reviewed.vsix');
    assert(!fs.existsSync(packagePath), '기존 검토용 패키지를 덮어쓰지 않는다.');
    for (const entry of ['package.json', 'README.md', 'LICENSE', '.vscodeignore', 'graph-mcp.cmd', 'config-graph-mcp.cmd',
        'tools', 'skill', 'dist/extension', 'dist/mcp', 'dist/wasm']) {
        fs.mkdirSync(path.dirname(path.join(stage, entry)), { recursive: true });
        fs.cpSync(path.join(project, entry), path.join(stage, entry), { recursive: true });
    }
    // 이미 검증한 번들을 그대로 복사하며 재빌드·전역 설정·게시를 실행하지 않는다.
    for (const entry of ['package.json', 'dist/extension/extension.js', 'dist/mcp/server.js']) {
        assert(fs.readFileSync(path.join(project, entry)).equals(fs.readFileSync(path.join(stage, entry))));
    }
    const result = await pack({ cwd: stage, packagePath, dependencies: false });
    console.log(JSON.stringify({ stage, packagePath: result.packagePath, files: result.files.length, bytes: fs.statSync(packagePath).size }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
