import { GraphIndex } from '../src/storage/index';
import { performance } from 'perf_hooks';
import assert from 'node:assert/strict';

/** 실제 해석된 관계 수를 확인하며 원격 이름 색인 측정을 현재 모델에 맞춘다. */
async function runBenchmark() {
    const index = new GraphIndex(__dirname);

    console.log('해석 측정용 입력 생성');

    // 언어 확장자를 보존해야 언어 계열별 이름 색인을 사용할 수 있다.
    const numSymbols = 10000;
    for (let i = 0; i < numSymbols; i++) {
        const symId = `file${i % 100}.ts::func${i}`;
        index.getGraphData().symbols[symId] = {
            id: symId,
            name: `func${i}`,
            kind: 'function',
            filePath: `file${i % 100}.ts`,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            language: 'typescript'
        };
    }

    // 원시 호출 사실을 현재 저장 모델에도 넣는다.
    const numRelations = 5000;
    for (let i = 0; i < numRelations; i++) {
        const targetFuncName = `func${i * 2 % numSymbols}`;
        const relId = `rel${i}`;
        index.getGraphData().relations[relId] = {
            id: relId,
            sourceId: `file0.ts::caller${i}`,
            targetId: `unknown::${targetFuncName}`,
            kind: 'call',
            certainty: 'UNRESOLVED'
        };
    }

    index.getGraphData().extractedRelations = structuredClone(index.getGraphData().relations);
    console.log(`심볼 ${numSymbols}개, 관계 ${numRelations}개`);

    const start = performance.now();
    index.resolveRelations();
    const end = performance.now();

    assert.equal(Object.values(index.getGraphData().relations).filter(relation => !relation.targetId.startsWith('unknown::')).length, numRelations);
    console.log(`관계 해석: ${end - start} ms`);
    index.dispose();
}

runBenchmark().catch(error => { console.error(error); process.exitCode = 1; });
