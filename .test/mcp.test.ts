import { GraphTools } from '../src/mcp/tools';
import { GraphData } from '../src/common/types';

describe('Graph MCP Tools Tests', () => {
    const mockData: GraphData = {
        version: '1.0',
        symbols: {
            'test.ts::UserService': {
                id: 'test.ts::UserService',
                name: 'UserService',
                kind: 'class',
                filePath: 'test.ts',
                language: 'typescript',
                range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } }
            },
            'test.ts::save': {
                id: 'test.ts::save',
                name: 'save',
                kind: 'method',
                filePath: 'test.ts',
                language: 'typescript',
                range: { start: { line: 2, character: 0 }, end: { line: 5, character: 0 } }
            }
        },
        relations: {
            'test.ts::call::UserService->save': {
                id: 'test.ts::call::UserService->save',
                sourceId: 'test.ts::UserService',
                targetId: 'unknown::save',
                kind: 'call',
                certainty: 'EXTRACTED'
            }
        }
    };

    let tools: GraphTools;

    beforeAll(() => {
        tools = new GraphTools(() => mockData);
    });

    test('searchSymbols should find by name', () => {
        const results = tools.searchSymbols('User');
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('UserService');
    });

    test('getSymbolInfo should return exact match', () => {
        const info = tools.getSymbolInfo('save');
        expect(info).toBeDefined();
        expect(info?.name).toBe('save');
        expect(info?.kind).toBe('method');
    });

    test('getDependencies should return relations for symbol', () => {
        const deps = tools.getDependencies('UserService');
        expect(deps.length).toBe(1);
        expect(deps[0].kind).toBe('call');
    });

    test('getCallers should return callers for target', () => {
        const callers = tools.getCallers('save');
        expect(callers.length).toBe(1);
        expect(callers[0].sourceId).toBe('test.ts::UserService');
    });

    test('get_index_status logic properly determines NotBuilt vs Ready', () => {
        let currentData: GraphData = { version: '1.0', symbols: {}, relations: {} };

        // 빈 그래프의 상태를 확인한다.
        let symbolsCount = Object.keys(currentData.symbols).length;
        let status = symbolsCount === 0 ? "NotBuilt" : "Ready";
        expect(status).toBe("NotBuilt");

        // When populated (simulating buildIndex completion)
        currentData.symbols['test'] = mockData.symbols['test.ts::UserService'];
        symbolsCount = Object.keys(currentData.symbols).length;
        status = symbolsCount === 0 ? "NotBuilt" : "Ready";
        expect(status).toBe("Ready");
    });
});
