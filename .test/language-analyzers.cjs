const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

/** 제품 번들을 변경하지 않고 현재 TypeScript 소스를 실행한다. */
require.extensions['.ts'] = function compile(module, filename) {
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, filename);
};

/** 기존 13개 언어 결과와 전략 확장·방언·예외 시 트리 해제를 한 흐름으로 확인한다. */
async function main() {
    const { CodeParser } = require('../src/core/parser.ts');
    const { AstLanguageAnalyzer, getLanguageAnalyzer, analyzeFile } = require('../src/core/analyzers.ts');
    const parser = new CodeParser();
    await parser.initialize(path.resolve(__dirname, '..'));
    const baseline = new Map(require('./language-baseline.json').map(row => [row.file, row.analysis]));
    try {
        for (const sample of require('./languages.json')) {
            const language = CodeParser.getLanguageFromFile(sample.file);
            assert.equal(getLanguageAnalyzer(language), getLanguageAnalyzer(language), '팩토리는 같은 언어의 전략을 재사용해야 한다.');
            const actual = analyzeFile(language, sample.code, sample.file, parser);
            assert.deepEqual(JSON.parse(JSON.stringify(actual)), baseline.get(sample.file), sample.file);
        }

        // 새 언어는 공통 방문기 수정 없이 두 추출 훅을 바꿀 수 있다.
        /** 공통 분석 절차에 독립 추출 훅만 연결하는 예제 전략이다. */
        class CustomAnalyzer extends AstLanguageAnalyzer {
            /** 사용자 정의 추출 훅이 전체 결과를 제공하는 테스트 전략이다. */
            getDeclaration() { return null; }
            /** 추상 전략의 노드 관계 계약을 명시적으로 구현한다. */
            extractNodeRelations() { return []; }
            /** 독립 선언 추출 전략의 결과를 반환한다. */
            extractSymbols(_tree, filePath) { return [{ id: `${filePath}::custom` }]; }
            /** 독립 관계 추출 전략의 결과를 반환한다. */
            extractRelations() { return []; }
        }
        let released = 0;
        const trackedParser = {
            /** 추출 예외가 나도 해제 여부를 관찰할 트리를 제공한다. */
            parse() { return { rootNode: { hasError: false }, delete() { released++; } }; }
        };
        const custom = new CustomAnalyzer('javascript');
        assert.equal(custom.analyze('', 'custom.js', trackedParser).symbols[0].id, 'custom.js::custom');
        assert.equal(released, 1);
        custom.extractRelations = function fail() { throw new Error('추출 실패'); };
        assert.throws(() => custom.analyze('', 'custom.js', trackedParser), /추출 실패/);
        assert.equal(released, 2);
        assert.throws(() => custom.analyze('', 'custom.js', { parse() { return null; } }), /파싱하지 못했습니다/);

        const header = getLanguageAnalyzer('c').analyze('class Header { public: void work() {} };', 'header.h', parser);
        assert.equal(header.hasError, false);
        assert(header.symbols.some(symbol => symbol.name === 'Header'));
        const partial = getLanguageAnalyzer('objcpp').analyze('@interface Sample\n@end', 'sample.mm', {
            /** 보조 문법이 없는 기존 부분 지원 경로를 재현한다. */
            parse(content, language) { return language === 'cpp' ? null : parser.parse(content, language); }
        });
        assert(partial.symbols.some(symbol => symbol.name === 'Sample'));
        assert.equal(getLanguageAnalyzer('typescript').family, getLanguageAnalyzer('javascript').family);
        assert.equal(getLanguageAnalyzer('java').implicitThis, true);
        assert.equal(getLanguageAnalyzer('python').implicitThis, false);
        console.log('통과: 13개 언어 원시 사실 동일, 독립 추출 전략, .h 대체 문법, 실패 시 트리 해제');
    } finally {
        parser.dispose();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
