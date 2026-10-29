import * as path from 'path';
import { Language, Position, Relation, SymbolInfo, SymbolKind } from '../../common/types';
import { CodeParser } from '../parser';
import languages from '../../common/languages.json';
import { NodeDeclaration, declarationName, extractCleanType, lookupReceiverType, nodeRange, visitAst } from '../declarations';
/** 한 파일에서 추출한 원시 사실과 구문 경고다. */
export interface LanguageAnalysis {
    symbols: SymbolInfo[];
    relations: Relation[];
    hasError: boolean;
}
/** 언어 전략은 AST 규칙을 소유하고 파사드는 이 계약만 사용한다. */
export interface LanguageAnalyzer {
    readonly family: string;
    readonly caseInsensitive?: boolean;
    readonly implicitThis: boolean;
    readonly importExtensions: readonly string[];
    /** 언어의 모듈 표기를 실제 파일 후보 경로로 변환한다. */
    getModuleCandidates(sourceFile: string, modulePath: string, root: string): string[];
    /** AST 자원을 정리하면서 파일 전체를 분석한다. */
    analyze(content: string, filePath: string, parser: CodeParser): LanguageAnalysis;
    /** 선언 노드의 이름과 종류를 해석한다. */
    getDeclaration(node: any): NodeDeclaration | null;
    /** 선언과 호출이 공유할 부모 범위를 반환한다. */
    getScope(node: any): string;
    /** 이미 파싱된 트리에서 심볼을 추출한다. */
    extractSymbols(tree: any, filePath: string): SymbolInfo[];
    /** 이미 파싱된 트리에서 원시 관계를 추출한다. */
    extractRelations(tree: any, filePath: string): Relation[];
}
/** 순회·결과 조립·AST 해제만 공유하고 구문 규칙은 언어 전략에 위임한다. */
export abstract class AstLanguageAnalyzer implements LanguageAnalyzer {
    public readonly importExtensions: readonly string[] = Object.values(languages).flatMap(config => config.extensions);
    /** 언어 문법과 교차 호출 계열·암묵적 수신자 정책을 지정한다. */
    constructor(protected readonly language: Language, public readonly family: string = language, public readonly implicitThis = false) { }
    /** 언어별 선언 규칙은 전략에서 반드시 구현한다. */
    public abstract getDeclaration(node: any): NodeDeclaration | null;
    /** 언어별 관계 규칙은 전략에서 반드시 구현한다. */
    protected abstract extractNodeRelations(node: any, filePath: string, receiverTypes: Map<string, string>): Relation[];
    /** 타입 증거가 없는 언어는 기본 수집 단계를 그대로 사용한다. */
    protected collectReceiverTypes(_node: any, _receiverTypes: Map<string, string>): void { }
    /** 기본 범위는 부모 선언 이름을 사용하며 언어 전략에서 재정의한다. */
    protected scopeName(node: any): string { return this.getDeclaration(node)?.name || ''; }
    /** 점으로 구분된 네이티브 모듈의 로컬·루트 후보를 순서대로 만든다. */
    public getModuleCandidates(sourceFile: string, modulePath: string, root: string): string[] {
        if (path.isAbsolute(modulePath) || !modulePath.includes('.')) return [];
        const relative = modulePath.replace(/^\.+/, '').split('.').filter(Boolean).join(path.sep);
        return relative ? [path.join(path.dirname(sourceFile), relative), path.join(root, relative)] : [];
    }
    /** 선언과 호출에 같은 범위 규칙을 적용한다. */
    public getScope(node: any): string {
        const parts: string[] = [];
        for (let parent = node.parent; parent; parent = parent.parent) {
            const name = this.scopeName(parent);
            if (name)
                parts.unshift(name);
        }
        return parts.join('::');
    }
    /** 기본 문법 선택은 방언 전략에서 재정의할 수 있다. */
    protected parse(content: string, _filePath: string, parser: CodeParser): any { return parser.parse(content, this.language); }
    /** 파싱 실패를 전달하고 채택한 트리의 추출·해제를 공통 처리한다. */
    public analyze(content: string, filePath: string, parser: CodeParser): LanguageAnalysis {
        const tree = this.parse(content, filePath, parser);
        if (!tree)
            throw new Error('지원 언어 파일을 파싱하지 못했습니다: ' + filePath);
        return this.extract(tree, filePath);
    }
    /** 모든 언어가 동일한 심볼 ID와 위치 형식을 사용하게 한다. */
    public extractSymbols(tree: any, filePath: string): SymbolInfo[] {
        const symbols: SymbolInfo[] = [];
        visitAst(tree.rootNode, node => {
            const declaration = this.getDeclaration(node);
            if (!declaration?.name)
                return;
            const scope = this.getScope(node);
            symbols.push({ ...declaration, id: scope ? filePath + '::' + scope + '::' + declaration.name : filePath + '::' + declaration.name,
                filePath, range: nodeRange(node), language: this.language });
        });
        return symbols;
    }
    /** 수신자 증거가 완성된 뒤 관계를 추출해 노드 순서 의존을 방지한다. */
    public extractRelations(tree: any, filePath: string): Relation[] {
        const receiverTypes = new Map<string, string>();
        visitAst(tree.rootNode, node => {
            this.collectReceiverTypes(node, receiverTypes);
            if (node.type === 'identifier' && ['parameters', 'formal_parameters'].includes(node.parent?.type)) {
                receiverTypes.set((this.getScope(node) || 'global') + '::' + node.text, 'member');
            }
        });
        const relations: Relation[] = [];
        visitAst(tree.rootNode, node => relations.push(...this.extractNodeRelations(node, filePath, receiverTypes)));
        return relations;
    }
    /** 실패 시에도 WASM 트리를 해제하며 기존 스냅샷은 호출자가 보존한다. */
    protected extract(tree: any, filePath: string): LanguageAnalysis {
        try {
            const symbols = this.extractSymbols(tree, filePath);
            const relations = this.extractRelations(tree, filePath);
            const declarations = new Map<string, SymbolInfo[]>();
            for (const symbol of symbols) {
                // 선언·정의 병합이 필요한 C/Objective-C와 함수 절을 합치는 Erlang은 유지한다.
                if (!['java', 'csharp', 'apex'].includes(symbol.language)) continue;
                if (!['function', 'method'].includes(symbol.kind)) continue;
                const group = declarations.get(symbol.id) || [];
                group.push(symbol);
                declarations.set(symbol.id, group);
            }
            const duplicates = [...declarations].filter(([, group]) => group.length > 1).sort(([left], [right]) => right.length - left.length);
            /** 중복 선언과 그 안쪽 범위에만 위치를 붙여 기존의 고유 ID는 유지한다. */
            function qualify(id: string, position?: Position): string {
                if (!position) return id;
                let qualified = id;
                for (const [original, group] of duplicates) {
                    if (id !== original && !id.startsWith(`${original}::`)) continue;
                    const owner = group.find(symbol => {
                        const { start, end } = symbol.range;
                        return (position.line > start.line || position.line === start.line && position.character >= start.character) &&
                            (position.line < end.line || position.line === end.line && position.character < end.character);
                    });
                    if (owner) qualified = `${qualified.slice(0, original.length)}@${owner.range.start.line}:${owner.range.start.character}${qualified.slice(original.length)}`;
                }
                return qualified;
            }
            for (const symbol of symbols) symbol.id = qualify(symbol.id, symbol.range.start);
            for (const relation of relations) {
                const source = qualify(relation.sourceId, relation.range?.start);
                // 오버로드 본문의 관계도 구별해 같은 대상 호출이 덮어써지지 않게 한다.
                if (source !== relation.sourceId) relation.id += `@${source}`;
                relation.sourceId = source;
                if (relation.lexicalBinding) relation.lexicalBinding = qualify(relation.lexicalBinding, relation.range?.start);
                if (relation.bindingScope) relation.bindingScope = qualify(relation.bindingScope, relation.range?.start);
            }
            return { hasError: Boolean(tree.rootNode.hasError), symbols, relations };
        }
        finally {
            tree.delete();
        }
    }
}
/** 네이티브 언어가 공유하는 호출·타입 증거·상속 조립 절차다. */
export abstract class NativeLanguageAnalyzer extends AstLanguageAnalyzer {
    protected abstract readonly declarationKinds: Record<string, SymbolKind>;
    protected readonly localIncludes: boolean = false;
    /** 임포트 AST의 형태는 각 언어가 해석한다. */
    protected abstract importPath(node: any): string;
    /** 언어 파일의 선언 표를 사용하고 오류 복구 노드의 오인식을 막는다. */
    public getDeclaration(node: any): NodeDeclaration | null {
        const kind = this.declarationKinds[node.type];
        if (!kind)
            return null;
        if (node.type === 'function_definition' && !node.childForFieldName('declarator')?.text.includes('('))
            return null;
        const name = declarationName(node);
        return name ? { name, kind } : null;
    }
    /** 명시적 네이티브 매개변수 타입을 수신자 증거로 사용한다. */
    protected collectReceiverTypes(node: any, receiverTypes: Map<string, string>): void {
        const scope = this.getScope(node) || 'global';
        if (['formal_parameter', 'parameter', 'parameter_declaration'].includes(node.type)) {
            const name = declarationName(node.childForFieldName('name') ?? node.childForFieldName('declarator'));
            if (name)
                receiverTypes.set(`${scope}::${name}`, extractCleanType(node.childForFieldName('type')?.text) || 'member');
        }
    }
    /** 언어별 선언·임포트 규칙의 결과로 공통 관계 형식을 조립한다. */
    protected extractNodeRelations(node: any, filePath: string, receiverTypes: Map<string, string>): Relation[] {
        const relations: Relation[] = [];
        const scope = this.getScope(node) || 'global';
        const range = nodeRange(node);
        if (['call_expression', 'method_invocation', 'invocation_expression', 'object_creation_expression'].includes(node.type)) {
            const called = node.childForFieldName('function') ?? node.childForFieldName('name') ?? node.childForFieldName('type');
            const name = (called?.childForFieldName('field') ?? called?.childForFieldName('name') ?? called)?.text?.split(/::|\.|->/).pop();
            const object = node.childForFieldName('object') ?? (['member_access_expression', 'field_expression', 'selector_expression'].includes(called?.type)
                ? called.childForFieldName('expression') ?? called.childForFieldName('argument') ?? called.childForFieldName('operand') : null);
            const receiver = object ? lookupReceiverType(scope, object.text === 'this' ? 'this' : object.text, receiverTypes) : undefined;
            if (name) {
                relations.push({
                    id: `${filePath}::call::${scope}->${name}@${node.startIndex}`,
                    sourceId: `${filePath}::${scope}`,
                    targetId: `unknown::${name}`,
                    kind: 'call',
                    certainty: 'EXTRACTED',
                    ...(receiver ? { receiver } : {}),
                    range
                });
            }
        }
        let imported = this.importPath(node);
        if (imported) {
            const local = imported.startsWith('"') && this.localIncludes;
            imported = imported.replace(/^["<`]|[">`]$/g, '');
            if (local)
                imported = path.resolve(path.dirname(filePath), imported);
            relations.push({
                id: `${filePath}::import::${imported}`,
                sourceId: filePath,
                targetId: imported,
                kind: 'import',
                certainty: 'EXTRACTED',
                range
            });
        }
        const declaration = this.getDeclaration(node);
        if (declaration?.kind === 'class' || declaration?.kind === 'interface') {
            const bases = [node.childForFieldName('superclass'), node.childForFieldName('interfaces'),
                node.childForFieldName('bases'), node.namedChildren.find((child: any) => child.type === 'base_class_clause')];
            for (const base of bases) {
                if (!base)
                    continue;
                const candidates = base.type === 'identifier' ? [base] : base.namedChildren.flatMap((child: any) => child.type === 'type_list' ? child.namedChildren : [child]);
                for (const target of candidates) {
                    if (target.type === 'access_specifier')
                        continue;
                    const kind = base.type === 'super_interfaces' ? 'implement' : 'inherit';
                    const targetName = target.text.replace(/<.*>$/, '').trim();
                    const owner = [this.getScope(node), declaration.name].filter(Boolean).join('::');
                    relations.push({
                        id: `${filePath}::${owner}::${kind}::${targetName}`,
                        sourceId: `${filePath}::${owner}`,
                        targetId: `unknown::${targetName}`,
                        kind,
                        certainty: 'EXTRACTED',
                        range
                    });
                }
            }
        }
        return relations;
    }
}
