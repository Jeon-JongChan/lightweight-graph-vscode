import languages from './languages.json';

export type Language = keyof typeof languages;

export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export type SymbolKind = 'class' | 'function' | 'method' | 'module' | 'interface' | 'variable';
export type RelationKind = 'import' | 'call' | 'inherit' | 'implement' | 'reference';
export type RelationCertainty = 'EXTRACTED' | 'RESOLVED' | 'INFERRED' | 'UNRESOLVED';

export interface SymbolInfo {
    id: string; // Unique ID (e.g. filepath::symbolname)
    name: string;
    kind: SymbolKind;
    filePath: string;
    range: Range;
    language: Language;
    documentation?: string;
}

export interface Relation {
    id: string;
    sourceId: string;
    targetId: string;
    kind: RelationKind;
    certainty: RelationCertainty;
    confidenceScore?: number; // 관계 해석 신뢰도 점수 (0.0 ~ 1.0)
    receiver?: string; // 멤버 호출 시 수신 객체 식별자 힌트 (예: parser, cache, this)
    bindings?: Record<string, string>; // 임포트의 로컬 이름에서 원래 이름으로 연결한다. *는 모듈 수신자다.
    bindingScope?: string; // 함수 내부 Python 임포트가 다른 범위로 새지 않게 한다.
    lexicalBinding?: string; // 매개변수·지역 변수가 같은 이름을 가리는 가장 가까운 범위다.
    range?: Range; // Where the relationship is declared in the source code
}

export interface GraphData {
    version: string;
    symbols: Record<string, SymbolInfo>;
    relations: Record<string, Relation>;
    extractedRelations?: Record<string, Relation>; // 증분 갱신 시 다시 해석할 원시 AST 사실이다.
}

export interface McpQueryOptions {
    maxDepth?: number;
    maxNodes?: number;
    maxResultChars?: number;
}
