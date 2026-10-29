import { Language } from '../../common/types';
import { CodeParser } from '../parser';
import { visitAst } from '../declarations';
import { LanguageAnalysis, LanguageAnalyzer } from './base';
import { JavascriptAnalyzer } from './javascript';
import { TypescriptAnalyzer } from './typescript';
/** Vue·Svelte·Astro·EJS의 스크립트를 실제 JS/TS AST로 분석한다. */
export class ComponentLanguageAnalyzer extends TypescriptAnalyzer {
    /** 컴포넌트도 JS/TS 호출·임포트 계열을 공유한다. */
    constructor(language: Language) { super(language); }
    /** 외곽 AST가 지정한 코드 영역만 분석하고 원본의 줄·열 위치를 보존한다. */
    public analyze(content: string, filePath: string, parser: CodeParser): LanguageAnalysis {
        const outer = parser.parse(content, this.language);
        if (!outer)
            throw new Error(`컴포넌트를 파싱하지 못했습니다: ${filePath}`);
        const result: LanguageAnalysis = { symbols: [], relations: [], hasError: Boolean(outer.rootNode.hasError) };
        try {
            visitAst(outer.rootNode, node => {
                const script = node.type === 'raw_text' && node.parent?.type === 'script_element';
                if (!script && node.type !== 'frontmatter_js_block' && !(this.language === 'ejs' && node.type === 'code'))
                    return;
                // 줄바꿈과 UTF-16 길이를 보존해 위치를 별도로 재매핑하지 않는다.
                const prefix = content.slice(0, node.startIndex).replace(/[^\r\n]/g, ' ');
                const code = prefix + node.text;
                const isTypescript = this.language === 'astro' || /\blang\s*=\s*["'](?:ts|typescript)["']/i.test(node.parent?.namedChild(0)?.text || '');
                const analyzer: LanguageAnalyzer = isTypescript ? new TypescriptAnalyzer() : new JavascriptAnalyzer();
                const analysis = analyzer.analyze(code, filePath, parser);
                result.symbols.push(...analysis.symbols.map(symbol => ({ ...symbol, language: this.language })));
                result.relations.push(...analysis.relations);
                result.hasError ||= analysis.hasError;
            });
            return result;
        }
        finally {
            outer.delete();
        }
    }
}
