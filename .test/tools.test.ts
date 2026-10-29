import { GraphTools } from '../src/mcp/tools';
import { GraphData } from '../src/common/types';
import { GraphIndex } from '../src/storage/index';

describe('Graph Tools Tests', () => {
    test('getProjectOverview returns correct stats', () => {
        const mockData: GraphData = {
            version: '1.0',
            symbols: {
                'file1.ts::func1': { id: 'file1.ts::func1', name: 'func1', kind: 'function', filePath: 'file1.ts', language: 'typescript', range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } },
                'file2.ts::class1': { id: 'file2.ts::class1', name: 'class1', kind: 'class', filePath: 'file2.ts', language: 'typescript', range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } }
            },
            relations: {
                'rel1': { id: 'rel1', sourceId: 'file1.ts::func1', targetId: 'file2.ts::class1', kind: 'call', certainty: 'EXTRACTED' }
            }
        };

        const tools = new GraphTools(() => mockData);
        const overview = tools.getProjectOverview();

        expect(overview.totalFiles).toBe(2);
        expect(overview.totalSymbols).toBe(2);
        expect(overview.totalRelations).toBe(1);
        expect(overview.symbolKinds['function']).toBe(1);
        expect(overview.symbolKinds['class']).toBe(1);
    });

    test('getCallees returns relations where target is called by source', () => {
        const mockData: GraphData = {
            version: '1.0',
            symbols: {
                'f1': { id: 'f1', name: 'func1', kind: 'function', filePath: 'file1.ts', language: 'typescript', range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } },
            },
            relations: {
                'r1': { id: 'r1', sourceId: 'f1', targetId: 'f2', kind: 'call', certainty: 'EXTRACTED' }
            }
        };

        const tools = new GraphTools(() => mockData);
        const callees = tools.getCallees('func1');
        expect(callees.length).toBe(1);
        expect(callees[0].targetId).toBe('f2');
    });

    test('getImpact returns symbols that call the target', () => {
        const mockData: GraphData = {
            version: '1.0',
            symbols: {
                'f1': { id: 'f1', name: 'func1', kind: 'function', filePath: 'file1.ts', language: 'typescript', range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } },
                'f2': { id: 'f2', name: 'func2', kind: 'function', filePath: 'file2.ts', language: 'typescript', range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } },
            },
            relations: {
                'r1': { id: 'r1', sourceId: 'f2', targetId: 'f1', kind: 'call', certainty: 'EXTRACTED' }
            }
        };

        const tools = new GraphTools(() => mockData);
        const impact = tools.getImpact('f1');
        expect(impact.length).toBe(1);
        expect(impact[0].name).toBe('func2');
    });

    test('resolveRelations assigns INFERRED or RESOLVED correctly', () => {
        const index = new GraphIndex('/fake');
        const data = index.getGraphData();

        // Exact match scenario in file1
        data.symbols['file1.ts::helper'] = { id: 'file1.ts::helper', name: 'helper', kind: 'function', filePath: 'file1.ts', language: 'typescript', range: { start: {line:0, character:0}, end: {line:0, character:0}} };
        data.symbols['file2.ts::helper'] = { id: 'file2.ts::helper', name: 'helper', kind: 'function', filePath: 'file2.ts', language: 'typescript', range: { start: {line:0, character:0}, end: {line:0, character:0}} };

        data.relations['rel1'] = { id: 'rel1', sourceId: 'file1.ts::caller', targetId: 'unknown::helper', kind: 'call', certainty: 'EXTRACTED' };

        // No exact match scenario in file3
        data.symbols['file3.ts::caller3'] = { id: 'file3.ts::caller3', name: 'caller3', kind: 'function', filePath: 'file3.ts', language: 'typescript', range: { start: {line:0, character:0}, end: {line:0, character:0}} };
        data.relations['rel2'] = { id: 'rel2', sourceId: 'file3.ts::caller3', targetId: 'unknown::helper', kind: 'call', certainty: 'EXTRACTED' };

        // 해석된 스냅샷과 원시 사실을 분리하는 현재 데이터 모델을 재현한다.
        data.extractedRelations = structuredClone(data.relations);
        (index as any).resolveRelations();

        // Exact match -> RESOLVED
        expect(data.relations['rel1'].targetId).toBe('file1.ts::helper');
        expect(data.relations['rel1'].certainty).toBe('RESOLVED');

        // 외부 후보가 둘이면 임의로 연결하지 않는다.
        expect(data.relations['rel2'].targetId).toBe('unknown::helper');
        expect(data.relations['rel2'].certainty).toBe('UNRESOLVED');
    });
});
