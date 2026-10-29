const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

/** 실제 배포 stdio 프로세스의 생성·조회·다중 프로젝트·CLI·오류 응답을 검증한다. */
async function main() {
    const root = fs.mkdtempSync(path.join(__dirname, 'mcp-run-'));
    const secondRoot = fs.mkdtempSync(path.join(__dirname, 'mcp-run-second-'));
    const languageRoot = fs.mkdtempSync(path.join(__dirname,'mcp-languages-'));
    const aliasRoot = fs.mkdtempSync(path.join(__dirname, 'mcp-reexports-'));
    fs.writeFileSync(path.join(aliasRoot, 'lib.ts'), 'export default function work() {}');
    fs.writeFileSync(path.join(aliasRoot, 'index.ts'), "export { default as run } from './lib';");
    fs.writeFileSync(path.join(aliasRoot, 'main.ts'), "import { run } from './index'; export function entry() { run(); }");
    const languageSamples = require('./language-support.json');
    for(const sample of languageSamples) {
        const directory=path.join(languageRoot,sample.language);
        fs.mkdirSync(directory,{recursive:true});
        fs.writeFileSync(path.join(directory,sample.file),sample.code);
    }
    fs.writeFileSync(path.join(root, 'Main.java'), 'class Service { int helper() { return 1; } int run() { return helper(); } }');
    fs.writeFileSync(path.join(secondRoot, 'app.py'), 'def util():\n    return 42\ndef entry():\n    return util()\n');
    const serverPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../dist/mcp/server.js');
    const client = new Client({ name: '검증 클라이언트', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath,
        args: [serverPath, root], stderr: 'pipe' });
    try {
        await client.connect(transport);
        const list = await client.listTools();
        assert(list.tools.some(tool => tool.name === 'build_index'));
        assert.equal(list.tools.length, 13);
        const initial = await client.callTool({ name: 'get_index_status', arguments: {} });
        assert.equal(JSON.parse(initial.content[0].text).status, 'NotBuilt');
        const built = await client.callTool({ name: 'build_index', arguments: {} });
        assert(!built.isError, JSON.stringify(built));
        const result = JSON.parse(built.content[0].text);
        assert.equal(result.filesIndexed, 1);
        assert(fs.existsSync(result.graphPath));
        assert(fs.existsSync(result.htmlPath));
        const found = await client.callTool({ name: 'search_symbols', arguments: { query: 'Service' } });
        assert.equal(JSON.parse(found.content[0].text)[0].language, 'java');
        const aliasesBuilt = await client.callTool({ name: 'build_index', arguments: { project_path: aliasRoot } });
        assert(!aliasesBuilt.isError, JSON.stringify(aliasesBuilt));
        const aliasCallees = await client.callTool({ name: 'get_callees', arguments: { target: 'entry', project_path: aliasRoot } });
        assert(JSON.parse(aliasCallees.content[0].text).some(rel => rel.targetId === `${path.join(aliasRoot, 'lib.ts')}::work`),
            '배포 번들과 저장 캐시에서도 기본 내보내기·재수출을 실제 선언에 연결해야 한다.');
        const callees = await client.callTool({ name: 'get_callees', arguments: { target: 'run' } });
        assert(JSON.parse(callees.content[0].text).some(rel => rel.targetId.endsWith('::Service::helper') && rel.certainty === 'RESOLVED'),
            'Java의 수신자 없는 동일 클래스 메서드 호출을 실제 대상으로 해석해야 한다.');
        const queried = await client.callTool({ name: 'query_graph', arguments: { question: 'Service', mode: 'bfs', depth: 2 } });
        assert(JSON.parse(queried.content[0].text).nodes.length > 0);
        const shortest = await client.callTool({ name: 'shortest_path', arguments: { source: 'run', target: 'helper' } });
        assert.equal(JSON.parse(shortest.content[0].text).found, true);
        const godNodes = await client.callTool({ name: 'get_god_nodes', arguments: { top_n: 5 } });
        assert(JSON.parse(godNodes.content[0].text).length > 0);
        const communities = await client.callTool({ name: 'get_communities', arguments: {} });
        assert(JSON.parse(communities.content[0].text).communities.length > 0);
        // 전역 MCP 서버가 project_path 인수로 다른 프로젝트도 즉시 색인·조회할 수 있는지 확인한다.
        const secondBuilt = await client.callTool({ name: 'build_index', arguments: { project_path: secondRoot } });
        assert(!secondBuilt.isError, JSON.stringify(secondBuilt));
        const secondFound = await client.callTool({ name: 'search_symbols', arguments: { query: 'entry', project_path: secondRoot } });
        assert.equal(JSON.parse(secondFound.content[0].text)[0].language, 'python');
        const status = await client.callTool({ name: 'get_index_status', arguments: {} });
        const details = JSON.parse(status.content[0].text);
        assert.equal(details.status, 'Ready');
        for (const language of ['java', 'go', 'rust', 'c', 'cpp', 'csharp']) assert(details.supportedLanguages.includes(language));
        for (const extension of require('./graphify-language-reference.json').extensions) assert(details.supportedExtensions.includes(extension.toLowerCase()), extension);
        const lock = path.join(path.dirname(result.cachePath), 'index.lock');
        fs.writeFileSync(lock, '검증이 소유한 잠금', { flag: 'wx' });
        try {
            const blocked = await client.callTool({ name: 'build_index', arguments: {} });
            assert.equal(blocked.isError, true);
        } finally { fs.unlinkSync(lock); }
        // CLI 직접 실행 모드도 검증한다.
        const cliStatus = JSON.parse(execFileSync(process.execPath, [serverPath, 'status', secondRoot], { encoding: 'utf8' }));
        assert.equal(cliStatus.status, 'Ready');
        const languagesBuilt=await client.callTool({name:'build_index',arguments:{project_path:languageRoot}});
        assert(!languagesBuilt.isError,JSON.stringify(languagesBuilt));
        const languagesResult=JSON.parse(languagesBuilt.content[0].text);
        assert.equal(languagesResult.filesIndexed,languageSamples.length);
        const languageCache=JSON.parse(fs.readFileSync(languagesResult.cachePath,'utf8'));
        for(const sample of languageSamples) for(const name of sample.symbols) {
            assert(languageCache.symbols[path.join(languageRoot,sample.language,sample.file)+'::'+name],sample.file+': '+name);
        }
        console.log('통과: 배포 번들 stdio 연결, 도구 13개, 다중 프로젝트(project_path), CLI 모드, 상태 갱신, 동시 생성 오류');
        console.log(`통과: 실제 MCP 프로세스의 신규 형식 ${languageSamples.length}개 생성·캐시 심볼·확장자 공개`);
    } finally { await client.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
