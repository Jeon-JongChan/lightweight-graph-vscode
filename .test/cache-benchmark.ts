import { GraphCache } from '../src/storage/cache';
import { GraphData } from '../src/common/types';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';

/** 실제 프로젝트 캐시를 건드리지 않고 원격에서 추가한 비동기 읽기 측정을 보존한다. */
async function runBenchmark() {
    const workspaceRoot = fs.mkdtempSync(path.join(__dirname, 'cache-benchmark-'));
    const cache = new GraphCache(workspaceRoot);
    const cachePath = cache.getCachePath();

    // 측정용 경로에만 캐시를 만든다.
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // 실제 저장 형식의 대형 캐시를 준비한다.
    const mockData: GraphData = {
        version: '1.0',
        symbols: {},
        relations: {}
    };

    // 큰 프로젝트를 흉내 내는 심볼·관계 10,000개를 채운다.
    for (let i = 0; i < 10000; i++) {
        mockData.symbols[`file${i}.ts::func${i}`] = {
            id: `file${i}.ts::func${i}`,
            name: `func${i}`,
            kind: 'function',
            filePath: `file${i}.ts`,
            language: 'typescript',
            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } }
        };
        mockData.relations[`rel${i}`] = {
            id: `rel${i}`,
            sourceId: `file${i}.ts::func${i}`,
            targetId: `file${i+1}.ts::func${i+1}`,
            kind: 'call',
            certainty: 'EXTRACTED'
        };
    }

    fs.writeFileSync(cachePath, JSON.stringify(mockData, null, 2), 'utf-8');
    console.log(`측정 캐시 크기: ${(fs.statSync(cachePath).size / 1024 / 1024).toFixed(2)} MB`);

    const loaded = await cache.load();
    assert(loaded && Object.keys(loaded.symbols).length === 10000);
    // 준비 실행은 측정에서 제외한다.
    for (let i = 0; i < 5; i++) {
        await cache.load();
    }

    // 같은 캐시를 비동기로 반복해서 읽는다.
    const iterations = 20;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        await cache.load();
    }
    const end = performance.now();

    const avgTime = (end - start) / iterations;
    console.log(`${iterations}회 평균 읽기: ${avgTime.toFixed(2)} ms`);

    console.log(`검사 입력 보존: ${workspaceRoot}`);
}

runBenchmark().catch(error => { console.error(error); process.exitCode = 1; });
