import { SymbolKind } from '../../common/types';
import { NativeLanguageAnalyzer, LanguageAnalyzer } from './base';
/** Go 함수·타입·receiver 메서드 범위와 import를 해석한다. */
export class GoAnalyzer extends NativeLanguageAnalyzer {
    protected readonly declarationKinds: Record<string, SymbolKind> = {
        type_spec: 'class', function_declaration: 'function', method_declaration: 'method'
    };
    /** Go는 다른 언어와 독립된 이름 계열을 사용한다. */
    constructor() { super('go'); }
    /** receiver 타입을 선언과 내부 호출자의 동일한 소유 범위로 사용한다. */
    public getScope(node: any): string {
        const parts: string[] = [];
        if (node.type === 'method_declaration') {
            const receiver = node.childForFieldName('receiver')?.namedChild(0)?.childForFieldName('type');
            if (receiver)
                parts.push(receiver.text.replace(/^\*/, '').replace(/\[.*\]$/, '').trim());
        }
        for (let parent = node.parent; parent; parent = parent.parent) {
            const declaration = this.getDeclaration(parent);
            if (declaration) {
                parts.unshift(declaration.name);
                if (parent.type === 'method_declaration') {
                    const receiver = parent.childForFieldName('receiver')?.namedChild(0)?.childForFieldName('type');
                    if (receiver)
                        parts.unshift(receiver.text.replace(/^\*/, '').replace(/\[.*\]$/, '').trim());
                }
            }
        }
        return parts.join('::');
    }
    /** Go import spec의 문자열 경로를 추출한다. */
    protected importPath(node: any): string { return node.type === 'import_spec' ? node.childForFieldName('path')?.text ?? '' : ''; }
}
/** Go의 실제 선언·관계 전략을 생성한다. */
export function createAnalyzer(): LanguageAnalyzer { return new GoAnalyzer(); }
