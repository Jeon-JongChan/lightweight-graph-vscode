import { SymbolKind } from '../../common/types';
import { NativeLanguageAnalyzer, LanguageAnalyzer } from './base';
/** Java 클래스·인터페이스·메서드 선언과 패키지 임포트를 해석한다. */
export class JavaAnalyzer extends NativeLanguageAnalyzer {
    protected readonly declarationKinds: Record<string, SymbolKind> = {
        class_declaration: 'class', interface_declaration: 'interface', record_declaration: 'class',
        enum_declaration: 'class', method_declaration: 'method', constructor_declaration: 'method'
    };
    /** Java의 클래스 내부 호출은 암묵적 this를 허용한다. */
    constructor() { super('java', 'java', true); }
    /** 일반·정적 import의 패키지 경로를 보존한다. */
    protected importPath(node: any): string {
        return node.type === 'import_declaration' ? node.text.replace(/^import\s+(?:static\s+)?|;$/g, '') : '';
    }
}
/** Java의 실제 선언·관계 전략을 생성한다. */
export function createAnalyzer(): LanguageAnalyzer { return new JavaAnalyzer(); }
