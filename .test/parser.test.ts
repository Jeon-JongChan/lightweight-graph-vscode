import { CodeParser } from '../src/core/parser';
import { getLanguageAnalyzer } from '../src/core/analyzers';
import { GraphIndex } from '../src/storage/index';

describe('Graph Core Tests', () => {
    let parser: CodeParser;

    beforeAll(async () => {
        parser = new CodeParser();
        await parser.initialize();
    });

    test('extracts symbols and relations from TS code', () => {
        const code = `
            import { something } from './module';

            class MyClass {
                myMethod() {
                    console.log('test');
                    something();
                }
            }

            const myVar = () => {};
        `;
        const tree = parser.parse(code, 'typescript');
        expect(tree).toBeDefined();

        const symbols = getLanguageAnalyzer('typescript').extractSymbols(tree, 'test.ts');
        expect(symbols.length).toBeGreaterThan(0);

        const classSym = symbols.find(s => s.name === 'MyClass' && s.kind === 'class');
        expect(classSym).toBeDefined();

        const methodSym = symbols.find(s => s.name === 'myMethod' && s.kind === 'method');
        expect(methodSym).toBeDefined();
        // check ID collision fix (should have scope)
        expect(methodSym?.id).toBe('test.ts::MyClass::myMethod');

        const arrowSym = symbols.find(s => s.name === 'myVar' && s.kind === 'function');
        expect(arrowSym).toBeDefined();

        const relations = getLanguageAnalyzer('typescript').extractRelations(tree, 'test.ts');
        expect(relations.length).toBeGreaterThan(0);

        const importRel = relations.find(r => r.kind === 'import');
        expect(importRel).toBeDefined();
        expect(importRel?.targetId).toContain('module');

        const callRel = relations.find(r => r.kind === 'call' && r.targetId.includes('something'));
        expect(callRel).toBeDefined();
    });

    test('relations should have scoped source IDs to avoid collisions', () => {
        const code = `
            class ClassA {
                run() {
                    helper();
                }
            }

            class ClassB {
                run() {
                    helper();
                }
            }
        `;
        const tree = parser.parse(code, 'typescript');
        expect(tree).toBeDefined();

        const relations = getLanguageAnalyzer('typescript').extractRelations(tree, 'test2.ts');
        const callsToHelper = relations.filter(r => r.kind === 'call' && r.targetId.includes('helper'));

        expect(callsToHelper.length).toBe(2);

        // Check if sourceIds are scoped differently
        const sourceIds = callsToHelper.map(r => r.sourceId);
        expect(sourceIds).toContain('test2.ts::ClassA::run');
        expect(sourceIds).toContain('test2.ts::ClassB::run');

        // Check if relation IDs are different
        const relationIds = callsToHelper.map(r => r.id);
        expect(relationIds[0]).not.toBe(relationIds[1]);
    });

    test('resolves import paths using resolveImports pass', async () => {
        // This requires testing the integration in GraphIndex
        const index = new GraphIndex('/fake/root');

        // Mock data directly to simulate parsed output before resolution
        const graphData = index.getGraphData();

        graphData.symbols['/fake/root/module.ts::funcA'] = {
            id: '/fake/root/module.ts::funcA',
            name: 'funcA',
            kind: 'function',
            filePath: '/fake/root/module.ts',
            range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
            language: 'typescript'
        };

        graphData.relations['/fake/root/main.ts::import::/fake/root/module'] = {
            id: '/fake/root/main.ts::import::/fake/root/module',
            sourceId: '/fake/root/main.ts',
            targetId: '/fake/root/module',
            kind: 'import',
            certainty: 'EXTRACTED'
        };

        // 해석기는 원시 AST 사실에서 시작하므로 fixture도 같은 저장소에 넣는다.
        graphData.extractedRelations = structuredClone(graphData.relations);
        (index as any).resolveImports();

        // Check if the relation targetId has been normalized to include .ts
        const relationsArray = Object.values(graphData.relations);
        expect(relationsArray.length).toBe(1);
        expect(relationsArray[0].targetId).toBe('/fake/root/module.ts');
        expect(relationsArray[0].certainty).toBe('RESOLVED');
        // Check if ID is updated properly
        expect(relationsArray[0].id).toBe('/fake/root/main.ts::import::/fake/root/module.ts');
    });

    test('extracts relations for require, export, and member expressions in JS/TS', () => {
        const code = `
            const myModule = require('./myModule');
            export * from './anotherModule';

            class TestClass {
                testMethod() {
                    const obj = { method: () => {} };
                    obj.method();
                }
            }
        `;
        const tree = parser.parse(code, 'typescript');
        expect(tree).toBeDefined();

        const relations = getLanguageAnalyzer('typescript').extractRelations(tree, 'test_relations.ts');

        // 1. require() should be extracted as import
        const requireRel = relations.find(r => r.kind === 'import' && r.targetId.includes('myModule'));
        expect(requireRel).toBeDefined();

        // 2. export from should be extracted as import
        const exportRel = relations.find(r => r.kind === 'import' && r.targetId.includes('anotherModule'));
        expect(exportRel).toBeDefined();

        // 3. obj.method() should be extracted as call with targetId including 'method'
        const callRel = relations.find(r => r.kind === 'call' && r.targetId.includes('method'));
        expect(callRel).toBeDefined();
    });

    test('extracts symbols from Python code', () => {
        const pyCode = `
import os

class PythonClass:
    def py_method(self):
        print('hello')
        self.other_method()

def py_func():
    pass
        `;
        const pyTree = parser.parse(pyCode, 'python');
        expect(pyTree).toBeDefined();

        const symbols = getLanguageAnalyzer('python').extractSymbols(pyTree, 'test.py');
        expect(symbols.length).toBeGreaterThan(0);

        const pyClass = symbols.find(s => s.name === 'PythonClass' && s.kind === 'class');
        expect(pyClass).toBeDefined();

        const pyMethod = symbols.find(s => s.name === 'py_method' && s.kind === 'function');
        expect(pyMethod).toBeDefined();
        // check python scope
        expect(pyMethod?.id).toBe('test.py::PythonClass::py_method');

        const pyFunc = symbols.find(s => s.name === 'py_func' && s.kind === 'function');
        expect(pyFunc).toBeDefined();
    });
});
