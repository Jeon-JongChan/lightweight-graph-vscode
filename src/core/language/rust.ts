import { SymbolKind } from '../../common/types';
import { NativeLanguageAnalyzer, LanguageAnalyzer } from './base';
/** Rust 선언·impl 소유 범위·use 경로를 해석한다. */
export class RustAnalyzer extends NativeLanguageAnalyzer {
    protected readonly declarationKinds: Record<string, SymbolKind> = {
        function_item: 'function', struct_item: 'class', enum_item: 'class', trait_item: 'interface',
        type_item: 'interface', mod_item: 'module'
    };
    /** Rust 심볼은 독립된 이름 계열을 사용한다. */
    constructor() { super('rust'); }
    /** impl 블록의 타입을 함수 소유 범위에 포함한다. */
    public getScope(node: any): string {
        const parts: string[] = [];
        for (let parent = node.parent; parent; parent = parent.parent) {
            const declaration = this.getDeclaration(parent);
            if (declaration)
                parts.unshift(declaration.name);
            else if (parent.type === 'impl_item')
                parts.unshift((parent.childForFieldName('type')?.text ?? 'impl').replace(/<.*>$/, '').trim());
        }
        return parts.join('::');
    }
    /** use 선언의 경로를 보존한다. */
    protected importPath(node: any): string { return node.type === 'use_declaration' ? node.childForFieldName('argument')?.text ?? '' : ''; }
}
/** Rust의 실제 선언·관계 전략을 생성한다. */
export function createAnalyzer(): LanguageAnalyzer { return new RustAnalyzer(); }
