const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');

/** 같은 입력의 현재 소스와 별도 Graphify 결과를 비교한다. */
require.extensions['.ts'] = function compile(module, filename) {
    module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{
        compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}
    }).outputText,filename);
};

/** 위치·ID 형식 차이를 제외하고 사람이 명시한 선언과 호출을 채점한다. */
async function main() {
    const {CodeParser}=require('../src/core/parser.ts');
    const {analyzeFile}=require('../src/core/analyzers.ts');
    const {RelationResolver}=require('../src/core/resolution.ts');
    const root=path.resolve(process.argv[2]||'.test/language-comparison');
    const reference=JSON.parse(fs.readFileSync(path.join(root,'.tools','.graphify','language-comparison.json'),'utf8'));
    const parser=new CodeParser();
    await parser.initialize(path.resolve(__dirname,'..'));
    const rows=[];
    try {
        for(const sample of require('./language-support.json')) {
            const file=path.join(root,sample.language,sample.file);
            const analysis=analyzeFile(sample.language,sample.code,file,parser);
            const data={version:'1.0',symbols:Object.fromEntries(analysis.symbols.map(s=>[s.id,s])),relations:Object.fromEntries(analysis.relations.map(r=>[r.id,r]))};
            new RelationResolver(data).resolve();
            const graphify=reference.samples.find(s=>s.file===sample.file).result;
            const gfSymbols=new Map((graphify.nodes||[]).map(n=>[n.id,n.label.replace(/^\./,'').replace(/\(.*$/,'').toLowerCase()]));
            const expected=sample.symbols.map(s=>s.split('::').pop().toLowerCase());
            const gfEdges=graphify.edges||[];
            const expectedCall=sample.call?.map(s=>s.split('::').pop().toLowerCase());
            const row={language:sample.language,expectedSymbols:expected.length,
                lightweightSymbols:sample.symbols.filter(s=>data.symbols[file+'::'+s]).length,
                graphifySymbols:expected.filter(name=>[...gfSymbols.values()].includes(name)).length,
                expectedCalls:expectedCall?1:0,
                lightweightCalls:sample.call?Number(Object.values(data.relations).some(r=>r.kind==='call'&&r.sourceId===file+'::'+sample.call[0]&&r.targetId===file+'::'+sample.call[1])):0,
                graphifyCalls:expectedCall?Number(gfEdges.some(e=>['calls','instantiates'].includes(e.relation)&&gfSymbols.get(e.source)===expectedCall[0]&&gfSymbols.get(e.target)===expectedCall[1])):0,
                graphifyError:graphify.error||null};
            assert.equal(row.lightweightSymbols,row.expectedSymbols,sample.file);
            assert.equal(row.lightweightCalls,row.expectedCalls,sample.file);
            rows.push(row);
        }
    } finally {parser.dispose();}
    const comparable=rows.filter(r=>!r.graphifyError);
    /** 양쪽이 실행된 입력만 합산하며 미설치 문법은 정확도 차이에 넣지 않는다. */
    function total(key) {return comparable.reduce((sum,row)=>sum+row[key],0);}
    const summary={graphifyVersion:reference.version,inputs:rows.length,comparable:comparable.length,
        unavailable:rows.filter(r=>r.graphifyError).map(r=>({language:r.language,error:r.graphifyError})),
        expectedSymbols:total('expectedSymbols'),lightweightSymbols:total('lightweightSymbols'),graphifySymbols:total('graphifySymbols'),
        expectedCalls:total('expectedCalls'),lightweightCalls:total('lightweightCalls'),graphifyCalls:total('graphifyCalls')};
    fs.writeFileSync(path.join(root,'.tools','.graphify','language-score.json'),JSON.stringify({summary,rows},null,2));
    console.log(JSON.stringify(summary,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
