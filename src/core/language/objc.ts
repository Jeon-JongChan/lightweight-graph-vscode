import { Language, SymbolKind } from '../../common/types';
import { NodeDeclaration } from '../declarations';
import { CAnalyzer, C_DECLARATIONS } from './c';
import { LanguageAnalyzer } from './base';
/** Objective-C의 클래스·프로토콜·메서드 selector와 C 선언을 해석한다. */
export class ObjectiveCAnalyzer extends CAnalyzer {
    protected readonly declarationKinds: Record<string, SymbolKind> = {
        ...C_DECLARATIONS, class_interface: 'class', class_implementation: 'class', protocol_declaration: 'interface',
        method_definition: 'method', method_declaration: 'method'
    };
    /** Objective-C++도 selector 해석과 C 선언자를 재사용한다. */
    constructor(language: Language = 'objc') { super(language, true); }
    /** selector의 조각을 결합하고 클래스·프로토콜은 첫 이름만 사용한다. */
    public getDeclaration(node: any): NodeDeclaration | null {
        if (['class_interface', 'class_implementation', 'protocol_declaration', 'method_definition', 'method_declaration'].includes(node.type)) {
            const identifiers = node.namedChildren.filter((child: any) => child.type === 'identifier');
            const name = node.type.startsWith('class_') || node.type === 'protocol_declaration'
                ? identifiers[0]?.text ?? '' : identifiers.map((child: any) => child.text).join(':');
            return name ? { name, kind: this.declarationKinds[node.type] } : null;
        }
        return super.getDeclaration(node);
    }
}
/** Objective-C의 실제 선언·관계 전략을 생성한다. */
export function createAnalyzer(): LanguageAnalyzer { return new ObjectiveCAnalyzer(); }
