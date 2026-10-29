import { SymbolKind } from '../../common/types';
import { NativeLanguageAnalyzer, LanguageAnalyzer } from './base';
/** C# 타입·메서드·네임스페이스 선언과 using을 해석한다. */
export class CsharpAnalyzer extends NativeLanguageAnalyzer {
    protected readonly declarationKinds: Record<string, SymbolKind> = {
        class_declaration: 'class', interface_declaration: 'interface', struct_declaration: 'class',
        record_declaration: 'class', enum_declaration: 'class', method_declaration: 'method',
        constructor_declaration: 'method', destructor_declaration: 'method',
        local_function_statement: 'function', namespace_declaration: 'module'
    };
    /** C# 멤버 본문에서 암묵적 this 호출을 허용한다. */
    constructor() { super('csharp', 'csharp', true); }
    /** using 선언의 경로를 관계 해석에 전달한다. */
    protected importPath(node: any): string { return node.type === 'using_directive' ? node.text.replace(/^using\s+|;$/g, '') : ''; }
}
/** C#의 실제 선언·관계 전략을 생성한다. */
export function createAnalyzer(): LanguageAnalyzer { return new CsharpAnalyzer(); }
