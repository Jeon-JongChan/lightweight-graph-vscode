import { Language } from '../../common/types';
import { LanguageAnalyzer } from './base';
import { NodeDeclaration } from '../declarations';
import { JavascriptAnalyzer } from './javascript';
/** JS 런타임 규칙에 TypeScript 선언·타입 참조·인터페이스 범위를 보강한다. */
export class TypescriptAnalyzer extends JavascriptAnalyzer {
    protected readonly typeReferences = true;
    protected readonly defaultAssignmentParameters = false;
    /** TSX는 문법만 달리하고 TypeScript 의미 규칙을 재사용한다. */
    constructor(language: Language = 'typescript') { super(language); }
    /** 인터페이스·타입 별칭·열거형은 TypeScript 전략에서 분류한다. */
    public getDeclaration(node: any): NodeDeclaration | null {
        const name = node.childForFieldName('name')?.text || '';
        if (['interface_declaration', 'type_alias_declaration'].includes(node.type))
            return { name, kind: 'interface' };
        if (node.type === 'enum_declaration')
            return { name, kind: 'class' };
        return super.getDeclaration(node);
    }
    /** 인터페이스 멤버에도 소유 범위를 부여한다. */
    protected scopeName(node: any): string {
        return node.type === 'interface_declaration' ? node.childForFieldName('name')?.text || '' : super.scopeName(node);
    }
}
/** TypeScript의 실제 분석 전략을 생성한다. */
export function createAnalyzer(): LanguageAnalyzer { return new TypescriptAnalyzer(); }
