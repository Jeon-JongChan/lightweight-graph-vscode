import { GraphData, Language, Relation, RelationCertainty, SymbolInfo } from '../common/types';
import { CodeParser } from './parser';
import { BUILTIN_CALL_NAMES } from './declarations';
import { disambiguateCandidates } from './candidates';
import { getLanguageAnalyzer } from './analyzers';

/** 한 규칙이 확정한 대상과 근거 수준이다. */
interface ResolutionMatch {
    target: SymbolInfo;
    certainty: RelationCertainty;
    score: number;
}

/** 규칙들이 공유하는 읽기 전용 후보와 상속 탐색 문맥이다. */
interface ResolutionContext {
    relation: Relation;
    data: GraphData;
    matches: SymbolInfo[];
    matchesSet: Set<SymbolInfo>;
    sourceFile: string;
    importedFiles: Set<string>;
    receiverTypes: SymbolInfo[];
    binding: { filePath: string; name: string } | null;
    bindingCandidates: SymbolInfo[];
    implicitThis: boolean;
    language: Language | null;
    ancestors: (classId: string) => string[];
}

/** 먼저 확정한 규칙의 결과를 채택하는 책임 연쇄 전략이다. */
interface ResolutionRule {
    name: string;
    resolve: (context: ResolutionContext) => ResolutionMatch | null;
}

/** JS·TS·TSX의 교차 임포트를 같은 문법 계열로 취급한다. */
function languageFamily(language: Language | null): string {
    return language ? getLanguageAnalyzer(language).family : '';
}

/** 언어가 허용하는 대소문자·Robot 키워드 규칙만 이름 색인에 적용한다. */
function canonicalName(language: Language | null, name: string): string {
    if (!language || !getLanguageAnalyzer(language).caseInsensitive) return name;
    return language === 'robot' ? name.toLowerCase().replace(/[\s_]/g,'') : name.toLowerCase();
}

/** 파일 경로는 보존하고 해당 언어의 심볼 이름만 비교한다. */
function scopedTarget(context: ResolutionContext, id: string): SymbolInfo | undefined {
    return context.data.symbols[id] || (context.language && getLanguageAnalyzer(context.language).caseInsensitive
        ? context.matches.find(symbol => symbol.filePath === id.split('::')[0] && canonicalName(context.language,symbol.id.slice(symbol.filePath.length)) === canonicalName(context.language,id.slice(symbol.filePath.length))) : undefined);
}

/** 전역·임포트로 접근 가능한 최상위 심볼인지 확인한다. */
function isTopLevel(symbol: SymbolInfo): boolean {
    return symbol.id.split('::').length === 2;
}

/** 현재 클래스와 상위 클래스에서만 this 호출을 해석한다. */
function resolveThis(context: ResolutionContext): ResolutionMatch | null {
    const { relation, data, ancestors } = context;
    if (relation.kind !== 'call' || relation.receiver !== 'this') return null;
    let owner = relation.sourceId;
    while (owner.includes('::')) {
        owner = owner.slice(0, owner.lastIndexOf('::'));
        if (!['class', 'interface'].includes(data.symbols[owner]?.kind)) continue;
        for (const classId of [owner, ...ancestors(owner)]) {
            const target = scopedTarget(context,`${classId}::${relation.targetId.slice('unknown::'.length)}`);
            if (target) return { target, certainty: 'RESOLVED', score: 0.95 };
        }
        return null;
    }
    return null;
}

/** 안쪽 함수부터 모듈까지 검색하고 무관한 클래스 멤버는 제외한다. */
function resolveLexical(context: ResolutionContext): ResolutionMatch | null {
    const { relation, data, sourceFile, matchesSet } = context;
    if (relation.receiver) return null;
    const name = relation.targetId.slice('unknown::'.length);
    let scope = relation.sourceId;
    while (true) {
        const target = scopedTarget(context,`${scope}::${name}`);
        if (target && !(relation.kind === 'call' && !context.implicitThis && ['class', 'interface'].includes(data.symbols[scope]?.kind)) &&
            matchesSet.has(target)) {
            return { target, certainty: 'RESOLVED', score: 1 };
        }
        if (relation.kind === 'call' && context.implicitThis && ['class', 'interface'].includes(data.symbols[scope]?.kind)) {
            for (const base of context.ancestors(scope)) {
                const inherited = scopedTarget(context,`${base}::${name}`);
                if (inherited && matchesSet.has(inherited)) return { target: inherited, certainty: 'RESOLVED', score: 0.95 };
            }
        }
        if (scope === relation.lexicalBinding) return null;
        if (scope === sourceFile || !scope.includes('::')) break;
        scope = scope.slice(0, scope.lastIndexOf('::'));
    }
    return null;
}

/** 수신자 타입에 해당하는 클래스와 부모 클래스의 멤버를 찾는다. */
function resolveReceiver(context: ResolutionContext): ResolutionMatch | null {
    const { relation, matchesSet, sourceFile, ancestors, importedFiles } = context;
    if (!relation.receiver || ['this', 'member'].includes(relation.receiver)) return null;
    const name = relation.targetId.slice('unknown::'.length);
    let owners = context.receiverTypes.filter(symbol => ['class', 'interface'].includes(symbol.kind));
    const imported = owners.filter(symbol => importedFiles.has(symbol.filePath));
    const local = owners.filter(symbol => symbol.filePath === sourceFile);
    owners = local.length ? local : imported.length ? imported : owners;
    const owner = disambiguateCandidates(owners, sourceFile);
    if (!owner) return null;
    for (const ownerId of [owner.id, ...ancestors(owner.id)]) {
        const target = scopedTarget(context,`${ownerId}::${name}`);
        if (target && matchesSet.has(target)) return { target, certainty: 'RESOLVED', score: 0.95 };
    }
    return null;
}

/** 명시적 임포트 파일에 있는 후보를 전역 추정보다 우선한다. */
function resolveImported(context: ResolutionContext): ResolutionMatch | null {
    if (context.relation.lexicalBinding || (context.relation.receiver && !context.relation.receiver.startsWith('namespace::'))) return null;
    if (!context.binding && context.relation.kind === 'call' && BUILTIN_CALL_NAMES.has(context.relation.targetId.slice('unknown::'.length))) return null;
    const candidates = context.binding ? context.bindingCandidates.filter(isTopLevel)
        : context.matches.filter(symbol => isTopLevel(symbol) && context.importedFiles.has(symbol.filePath));
    const target = disambiguateCandidates(candidates, context.sourceFile);
    return target ? { target, certainty: 'RESOLVED', score: 0.9 } : null;
}

/** Graphify와 같이 전역 유일 후보·테스트 제외·경로 근접도로 보수적으로 추론한다. */
function resolveGlobal(context: ResolutionContext): ResolutionMatch | null {
    if (context.relation.receiver || context.relation.lexicalBinding || context.binding) return null;
    if (context.relation.kind === 'call' && BUILTIN_CALL_NAMES.has(context.relation.targetId.slice('unknown::'.length))) return null;
    const candidates = context.matches.filter(isTopLevel);
    const target = disambiguateCandidates(candidates, context.sourceFile);
    return target ? { target, certainty: 'INFERRED', score: 0.85 } : null;
}

// Graphify symbol_resolution.py와 paths.py의 대응 규칙은 순서를 보존하여 교체한다.
const RESOLUTION_RULES: readonly ResolutionRule[] = [
    { name: 'this-and-ancestors', resolve: resolveThis },
    { name: 'lexical-scope', resolve: resolveLexical },
    { name: 'receiver-type', resolve: resolveReceiver },
    { name: 'import-guided', resolve: resolveImported },
    { name: 'unique-or-proximity', resolve: resolveGlobal }
];

/** 이름 색인·상속 계층을 한 번 만들고 규칙 전략으로 관계를 해석한다. */
export class RelationResolver {
    private byName = new Map<string, SymbolInfo[]>();
    private importedByFile = new Map<string, Set<string>>();
    private bindingsByScope = new Map<string, Map<string, { filePath: string; name: string }>>();
    private supertypes = new Map<string, Set<string>>();
    private ancestorCache = new Map<string, string[]>();
    private exportsByFile = new Map<string, Map<string, string[]>>();
    private reexportsByFile = new Map<string, Relation[]>();

    /** Graphify의 label index와 같은 역할의 언어 계열·이름 색인을 만든다. */
    constructor(private data: GraphData) {
        for (const symbol of Object.values(data.symbols)) {
            const key = `${languageFamily(symbol.language)}::${canonicalName(symbol.language,symbol.name)}`;
            const candidates = this.byName.get(key) || [];
            candidates.push(symbol);
            this.byName.set(key, candidates);
            if (symbol.exportNames?.length && isTopLevel(symbol)) {
                const exports = this.exportsByFile.get(symbol.filePath) || new Map<string, string[]>();
                for (const name of symbol.exportNames) exports.set(name, [...(exports.get(name) || []), symbol.name]);
                this.exportsByFile.set(symbol.filePath, exports);
            }
        }
        for (const relation of Object.values(data.relations)) {
            if (relation.kind === 'import') {
                if (relation.reexports) {
                    const forwarded = this.reexportsByFile.get(relation.sourceId) || [];
                    forwarded.push(relation);
                    this.reexportsByFile.set(relation.sourceId, forwarded);
                    continue;
                }
                const targets = this.importedByFile.get(relation.sourceId) || new Set<string>();
                targets.add(relation.targetId);
                this.importedByFile.set(relation.sourceId, targets);
                const scope = relation.bindingScope || relation.sourceId;
                const bindings = this.bindingsByScope.get(scope) || new Map();
                for (const [local, name] of Object.entries(relation.bindings || {})) bindings.set(local, { filePath: relation.targetId, name });
                this.bindingsByScope.set(scope, bindings);
            } else if (['inherit', 'implement'].includes(relation.kind) && !relation.targetId.startsWith('unknown::')) {
                this.recordSupertype(relation);
            }
        }
    }

    /** 재수출의 순환·모호성을 차단하고 기본 내보내기의 실제 선언 이름을 찾는다. */
    private findExport(filePath: string, name: string, seen = new Set<string>()): { filePath: string; name: string } | null {
        if (name === '*') return { filePath, name };
        const key = `${filePath}::${name}`;
        if (seen.has(key)) return null;
        seen.add(key);
        const aliases = this.exportsByFile.get(filePath)?.get(name);
        if (aliases?.length === 1) return { filePath, name: aliases[0] };
        const language = CodeParser.getLanguageFromFile(filePath);
        const local = this.byName.get(`${languageFamily(language)}::${canonicalName(language, name)}`) || [];
        if (local.some(symbol => symbol.filePath === filePath && isTopLevel(symbol))) return { filePath, name };
        const forwarded = this.reexportsByFile.get(filePath) || [];
        const named = forwarded.filter(relation => Object.hasOwn(relation.reexports!, name));
        // export *는 default를 전달하지 않으며 명시적 이름이 별표보다 우선한다.
        const candidates = named.length ? named : name === 'default' ? [] : forwarded.filter(relation => relation.reexports?.['*'] === '*');
        const targets = candidates.map(relation => this.findExport(relation.targetId, named.length ? relation.reexports![name] : name, new Set(seen)))
            .filter((target): target is { filePath: string; name: string } => target !== null);
        const unique = new Map(targets.map(target => [`${target.filePath}::${target.name}`, target]));
        return unique.size === 1 ? unique.values().next().value! : null;
    }

    /** 함수 내부 임포트는 해당 함수와 자식 범위에서만 사용한다. */
    private findBinding(scope: string, name: string): { filePath: string; name: string } | null {
        while (true) {
            const binding = this.bindingsByScope.get(scope)?.get(name);
            if (binding) return this.findExport(binding.filePath, binding.name) || binding;
            if (!scope.includes('::')) return null;
            scope = scope.slice(0, scope.lastIndexOf('::'));
        }
    }

    /** 이미 확인한 상속 관계를 계층에 등록하고 조상 캐시를 비운다. */
    private recordSupertype(relation: Relation): void {
        const targets = this.supertypes.get(relation.sourceId) || new Set<string>();
        if (!targets.has(relation.targetId)) {
            targets.add(relation.targetId);
            this.supertypes.set(relation.sourceId, targets);
            this.ancestorCache.clear();
        }
    }

    /** 순환 상속에 종료가 보장되는 너비 우선 탐색을 수행하며 결과를 캐시한다. */
    private ancestors = (classId: string): string[] => {
        const cached = this.ancestorCache.get(classId);
        if (cached) return cached;
        const queue = [classId];
        const visited = new Set(queue);
        for (let head = 0; head < queue.length; head++) {
            for (const base of this.supertypes.get(queue[head]) || []) {
                if (visited.has(base)) continue;
                visited.add(base);
                queue.push(base);
            }
        }
        const result = queue.slice(1);
        this.ancestorCache.set(classId, result);
        return result;
    };

    /** 상속·참조를 먼저 해석하여 호출 전략이 완성된 계층을 사용하게 한다. */
    public resolve(): void {
        const relations = Object.values(this.data.relations);
        const ordered = [
            ...relations.filter(rel => ['inherit', 'implement'].includes(rel.kind)),
            ...relations.filter(rel => rel.kind === 'reference'),
            ...relations.filter(rel => rel.kind === 'call')
        ];
        for (const relation of ordered) {
            if (!relation.targetId.startsWith('unknown::')) continue;
            const sourceFile = relation.sourceId.split('::')[0];
            const sourceLanguage = CodeParser.getLanguageFromFile(sourceFile);
            const family = languageFamily(sourceLanguage);
            const key = `${family}::${canonicalName(sourceLanguage,relation.targetId.slice('unknown::'.length))}`;
            const matches = (this.byName.get(key) || []).filter(symbol => relation.kind !== 'call' ||
                ['class', 'function', 'method'].includes(symbol.kind));
            const matchesSet = new Set(matches);
            const namespace = relation.receiver?.startsWith('namespace::') ? relation.receiver.slice('namespace::'.length) : null;
            let binding = !relation.lexicalBinding && (namespace || !relation.receiver)
                ? this.findBinding(relation.sourceId, namespace || relation.targetId.slice('unknown::'.length)) : null;
            if (namespace && binding?.name === '*') binding = this.findExport(binding.filePath, relation.targetId.slice('unknown::'.length)) || binding;
            const bindingCandidates = binding ? (this.byName.get(`${family}::${canonicalName(sourceLanguage,binding.name === '*' ? relation.targetId.slice('unknown::'.length) : binding.name)}`) || [])
                .filter(symbol => symbol.filePath === binding.filePath && (relation.kind !== 'call' || ['class', 'function', 'method'].includes(symbol.kind))) : [];
            const typeBinding = relation.receiver && !namespace ? this.findBinding(relation.sourceId, relation.receiver) : null;
            const receiverTypes = relation.receiver ? (this.byName.get(`${family}::${canonicalName(sourceLanguage,typeBinding?.name || relation.receiver)}`) || [])
                .filter(symbol => !typeBinding || symbol.filePath === typeBinding.filePath) : [];
            const context: ResolutionContext = {
                relation, data: this.data, matches, matchesSet, sourceFile, binding, bindingCandidates, language:sourceLanguage,
                importedFiles: this.importedByFile.get(sourceFile) || new Set<string>(), ancestors: this.ancestors,
                receiverTypes,
                // Java·C#·C++ 계열의 멤버 본문은 수신자 없이 같은 클래스의 메서드를 호출할 수 있다.
                implicitThis: Boolean(sourceLanguage && getLanguageAnalyzer(sourceLanguage).implicitThis)
            };
            let found: ResolutionMatch | null = null;
            for (const rule of RESOLUTION_RULES) {
                found = rule.resolve(context);
                if (found) break;
            }
            if (found) {
                relation.targetId = found.target.id;
                relation.certainty = found.certainty;
                relation.confidenceScore = found.score;
                if (['inherit', 'implement'].includes(relation.kind)) this.recordSupertype(relation);
            } else if (relation.kind === 'reference' || relation.receiver || (relation.kind === 'call' && BUILTIN_CALL_NAMES.has(relation.targetId.slice('unknown::'.length)))) {
                delete this.data.relations[relation.id];
            } else {
                relation.certainty = 'UNRESOLVED';
                relation.confidenceScore = 0.2;
            }
        }
    }
}
