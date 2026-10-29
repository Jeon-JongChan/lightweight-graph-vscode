import * as path from 'path';
import { Language, SymbolKind } from '../../common/types';
import { CodeParser } from '../parser';
import { NodeDeclaration, declarationName } from '../declarations';
import { NativeLanguageAnalyzer, LanguageAnalyzer } from './base';
/** C 선언과 공유 .h의 C++ 대체 문법에서 허용할 선언이다. */
export const C_DECLARATIONS: Record<string, SymbolKind> = {
    struct_specifier: 'class', union_specifier: 'class', enum_specifier: 'class',
    type_definition: 'interface', function_definition: 'function',
    class_specifier: 'class', namespace_definition: 'module'
};
/** C 선언자·include·헤더 대체 문법을 담당한다. */
export class CAnalyzer extends NativeLanguageAnalyzer {
    protected readonly declarationKinds = C_DECLARATIONS;
    protected readonly localIncludes = true;
    /** 파생 C 계열 언어도 선언자와 include 해석을 재사용한다. */
    constructor(language: Language = 'c', implicitThis = false) { super(language, language, implicitThis); }
    /** 함수 원형은 정의와 같은 이름 추출을 사용한다. */
    public getDeclaration(node: any): NodeDeclaration | null {
        if (node.type === 'function_declarator' && ['declaration', 'field_declaration'].includes(node.parent?.type)) {
            const name = declarationName(node);
            return name ? { name, kind: 'function' } : null;
        }
        return super.getDeclaration(node);
    }
    /** 따옴표 include의 상대 경로 처리는 공통 관계 조립기가 수행한다. */
    protected importPath(node: any): string { return node.type === 'preproc_include' ? node.childForFieldName('path')?.text ?? '' : ''; }
    /** 공유 .h에서만 오류 없는 C++ 대체 트리를 채택한다. */
    protected parse(content: string, filePath: string, parser: CodeParser): any {
        const tree = super.parse(content, filePath, parser);
        if (!tree?.rootNode.hasError || path.extname(filePath) !== '.h')
            return tree;
        let alternative;
        try {
            alternative = parser.parse(content, 'cpp');
        }
        catch (error) {
            tree.delete();
            throw error;
        }
        if (alternative && !alternative.rootNode.hasError) {
            tree.delete();
            return alternative;
        }
        alternative?.delete();
        return tree;
    }
}
/** C의 실제 선언·관계 전략을 생성한다. */
export function createAnalyzer(): LanguageAnalyzer { return new CAnalyzer(); }
