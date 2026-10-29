import { CodeParser } from '../parser';
import { ObjectiveCAnalyzer } from './objc';
import { LanguageAnalysis, LanguageAnalyzer } from './base';
/** Objective-C++의 selector와 C++ 선언을 두 문법에서 병합한다. */
export class ObjectiveCppAnalyzer extends ObjectiveCAnalyzer {
    /** Objective-C++ 문법 선택과 Objective-C 선언 규칙을 연결한다. */
    constructor() { super('objcpp'); }
    /** 주 문법의 경고와 보조 문법 null 허용 정책을 보존한다. */
    public analyze(content: string, filePath: string, parser: CodeParser): LanguageAnalysis {
        const primary = super.analyze(content, filePath, parser);
        const tree = parser.parse(content, 'cpp');
        if (!tree)
            return primary;
        const secondary = this.extract(tree, filePath);
        primary.symbols.push(...secondary.symbols);
        primary.relations.push(...secondary.relations);
        return primary;
    }
}
/** Objective-C++의 실제 선언·관계 전략을 생성한다. */
export function createAnalyzer(): LanguageAnalyzer { return new ObjectiveCppAnalyzer(); }
