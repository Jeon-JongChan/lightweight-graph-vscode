const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

/** 배포 번들을 덮어쓰지 않고 현재 TypeScript 소스를 검증한다. */
require.extensions['.ts'] = function compile(module, filename) {
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, filename);
};

/** 언어 판별·실제 추출·관계 해석·파일 탐색·배포 자산을 한 흐름으로 검사한다. */
async function main() {
    const { CodeParser } = require('../src/core/parser.ts');
    const { analyzeFile } = require('../src/core/analyzers.ts');
    const { ImportResolver } = require('../src/core/imports.ts');
    const { RelationResolver } = require('../src/core/resolution.ts');
    const { buildProjectIndex, ProjectWatcher } = require('../src/core/build.ts');
    const { GraphCache } = require('../src/storage/cache.ts');
    const { deflateSync } = require('node:zlib');
    const reference = require('./graphify-language-reference.json');
    for (const extension of reference.extensions) {
        assert(CodeParser.getLanguageFromFile(`example${extension}`), `Graphify 지원 확장자 누락: ${extension}`);
    }
    assert.equal(CodeParser.getLanguageFromFile('package-lock.json'),null,'생성된 잠금 파일은 코드 그래프에서 제외한다.');
    const parser = new CodeParser();
    await parser.initialize(path.resolve(__dirname, '..'));
    const results = [];
    const root = fs.mkdtempSync(path.join(__dirname,'language-support-'));
    try {
        for (const sample of require('./language-support.json')) {
            assert.equal(CodeParser.getLanguageFromFile(sample.file), sample.language, sample.file);
            const file = path.resolve(__dirname, sample.file);
            const analysis = analyzeFile(sample.language, sample.code, file, parser);
            for (const name of sample.symbols) assert(analysis.symbols.some(s => s.id === `${file}::${name}`), `${sample.file}: 심볼 ${name}`);
            if (sample.import) assert(analysis.relations.some(r => r.kind === 'import' && r.targetId.replaceAll('\\', '/').endsWith(sample.import.replace(/^\.\//, ''))), `${sample.file}: 임포트 ${sample.import}`);
            if(sample.file.endsWith('.psd1')) assert(!analysis.relations.some(r=>r.kind==='import'&&r.targetId.endsWith('1.0')),'매니페스트 버전은 임포트 대상이 아니다.');
            const data = { version: '1.0', symbols: Object.fromEntries(analysis.symbols.map(s => [s.id,s])), relations: Object.fromEntries(analysis.relations.map(r => [r.id,r])) };
            new ImportResolver(data, __dirname).resolve();
            new RelationResolver(data).resolve();
            for (const kind of ['call','reference']) {
                if (!sample[kind]) continue;
                const [source,target] = sample[kind];
                assert(Object.values(data.relations).some(r => r.kind === kind && r.sourceId === `${file}::${source}` && r.targetId === `${file}::${target}`), `${sample.file}: ${source} -> ${target}`);
            }
            results.push({ language: sample.language, symbols: analysis.symbols.length, relations: analysis.relations.length, hasError: analysis.hasError });
            const directory = path.join(root,sample.language);
            fs.mkdirSync(directory,{recursive:true});
            fs.writeFileSync(path.join(directory,sample.file),sample.code);
        }
        for (const [language,code,source,target] of [
            ['powershell','function Helper {}\nfunction Run { hElPeR }','Run','Helper'],
            ['fortran','subroutine Helper()\nend subroutine Helper\nsubroutine Run()\n call hELper()\nend subroutine Run\n','Run','Helper'],
            ['pascal','program Test; procedure Helper; begin end; procedure Run; begin hELper(); end; begin end.','Run','Helper'],
            ['vbnet','Sub Helper()\nEnd Sub\nSub Run()\nhElPer()\nEnd Sub','Run','Helper'],
            ['robot','*** Keywords ***\nSome Helper\n    No Operation\nRun\n    some_helper\n','Run','Some Helper']
        ]) {
            const extension = require('../src/common/languages.json')[language].extensions[0];
            const file = path.join(root,language + '-case'+extension);
            const analysis = analyzeFile(language,code,file,parser);
            const data = {version:'1.0',symbols:Object.fromEntries(analysis.symbols.map(s=>[s.id,s])),relations:Object.fromEntries(analysis.relations.map(r=>[r.id,r]))};
            new RelationResolver(data).resolve();
            assert(Object.values(data.relations).some(r=>r.sourceId.endsWith('::'+source)&&r.targetId.endsWith('::'+target)), language+': 대소문자 규칙');
        }
        // 문자열·주석에 들어 있는 가짜 선언과 호출은 AST 사실이 아니다.
        for (const [language,code] of [
            ['ruby','# def fake()\ntext = "fake()"\n'], ['powershell',"# function Fake {}\n$text = 'Fake'\n"],
            ['bash',"# fake() { :; }\necho 'fake()'\n"], ['vbnet',"' Sub Fake()\nDim text = \"Fake()\"\n"]
        ]) {
            const analysis=analyzeFile(language,code,'noise',parser);
            assert(!analysis.symbols.some(s=>/fake/i.test(s.name)),language+': 가짜 선언');
            assert(!analysis.relations.some(r=>r.kind==='call'&&/unknown::fake$/i.test(r.targetId)),language+': 가짜 호출');
        }
        for(const [language,code] of [
            ['ruby','require dynamic_path\n'], ['lua','require(dynamic_path)\n'], ['r','source(dynamic_path)\n'],
            ['bash','source "$dynamic_path"\n'], ['powershell','Import-Module $dynamic_path\n']
        ]) assert(!analyzeFile(language,code,'dynamic',parser).relations.some(r=>r.kind==='import'),language+': 동적 임포트 오인식');
        // 한 스크립트의 문자열에 포함된 닫는 태그와 한글 앞에서도 원본 위치를 유지한다.
        const component='<p>한글</p>\r\n<script lang="ts">\r\nfunction 위치() {}\r\n</script>';
        const positioned=analyzeFile('vue',component,'position.vue',parser).symbols.find(s=>s.name==='위치');
        assert.equal(positioned.range.start.line,2);
        assert.equal(positioned.range.start.character,0);
        const payload=Buffer.concat([Buffer.from('Description\0\0','latin1'),deflateSync('state = "idle"\n')]);
        const chunk=Buffer.alloc(payload.length+12);
        chunk.writeUInt32BE(payload.length); chunk.write('zTXt',4); payload.copy(chunk,8);
        const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk]);
        assert(analyzeFile('dmi',png.toString('latin1'),'sample.dmi',parser).symbols.some(s=>s.name==='idle'));
        assert.throws(()=>analyzeFile('dmi','잘못된 PNG','bad.dmi',parser),/PNG/);
        assert.throws(()=>analyzeFile('dmi',png.subarray(0,png.length-1).toString('latin1'),'truncated.dmi',parser),/청크/);
        const expanded=Buffer.concat([Buffer.from('Description\0\0','latin1'),deflateSync(Buffer.alloc(8*1024*1024+1,65))]);
        const oversized=Buffer.alloc(expanded.length+12);
        oversized.writeUInt32BE(expanded.length); oversized.write('zTXt',4); expanded.copy(oversized,8);
        assert.throws(()=>analyzeFile('dmi',Buffer.concat([png.subarray(0,8),oversized]).toString('latin1'),'oversized.dmi',parser),/larger|length|크기/i);
        fs.writeFileSync(path.join(root,'sample.dmi'),png);
    } finally { parser.dispose(); }
    // 반복 생성·Watch에서 문법을 재로드해 WASM 함수 테이블을 고갈시키면 안 된다.
    for(let iteration=0;iteration<40;iteration++) {
        const repeated=new CodeParser();
        await repeated.initialize(path.resolve(__dirname,'..'));
        const tree=repeated.parse('def helper; end','ruby');
        assert(tree); tree.delete(); repeated.dispose();
    }
    fs.writeFileSync(path.join(root,'empty.json'),'{}');
    fs.writeFileSync(path.join(root,'ref.json'),'{"$ref":"./empty.json"}');
    const built=await buildProjectIndex(root,path.resolve(__dirname,'..'));
    assert.equal(built.filesIndexed,results.length+3);
    const graph=JSON.parse(fs.readFileSync(built.graphPath,'utf8'));
    assert(graph.nodes.some(n=>n.id==='empty.json'&&n.kind==='file'),'선언 없는 파일도 내보내야 한다.');
    const cache=new GraphCache(root);
    const data=await cache.load();
    assert(data.files.includes(path.join(root,'empty.json')));
    assert(Object.values(data.relations).some(r=>r.kind==='import'&&r.sourceId===path.join(root,'ref.json')&&r.targetId===path.join(root,'empty.json')&&r.certainty==='RESOLVED'));
    const watcher=new ProjectWatcher(root,path.resolve(__dirname,'..'),{debounceMs:20});
    watcher.start();
    try {
        const watched=path.join(root,'ruby','sample.rb');
        fs.writeFileSync(watched,'def changed_language_symbol; end\n');
        watcher.notifyFileChanged(watched);
        await watcher.waitForIdle();
        assert((await cache.load()).symbols[watched+'::changed_language_symbol']);
    } finally { watcher.stop(); }
    const output=path.join(root,'.tools','.graphify','language-check.json');
    fs.writeFileSync(output,JSON.stringify({graphify:reference.version,extensions:reference.extensions.length,samples:results},null,2));
    console.log(`통과: Graphify ${reference.version} 확장자 ${reference.extensions.length}개, 신규 형식 ${results.length}개, 대소문자·오인식·원본 위치·DMI·선언 없는 파일·Watch`);
    console.log(`검증 결과: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
