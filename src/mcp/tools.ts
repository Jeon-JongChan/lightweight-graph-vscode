import { GraphData, SymbolInfo, Relation } from '../common/types';
import { buildExportedGraph, ExportedLink, ExportedNode, GodNodeInfo, portableId } from '../storage/export';

/** 자연어 질문에서 시드 선택을 왜곡하는 영어·한국어 질문 불용어 목록이다. */
const QUERY_STOPWORDS = new Set([
    'how', 'what', 'why', 'when', 'where', 'which', 'who', 'whom', 'whose',
    'does', 'did', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
    'has', 'have', 'had', 'the', 'and', 'but', 'not', 'for', 'from', 'with',
    'without', 'into', 'onto', 'that', 'this', 'these', 'those', 'there', 'here',
    'work', 'works', 'working', 'get', 'gets', 'got', 'getting',
    '어떻게', '무엇', '무슨', '왜', '어디', '어디서', '언제', '누가', '어떤',
    '하는', '하고', '에서', '으로', '에게', '부터', '까지', '대한', '관련',
    '동작', '작동', '역할', '기능', '설명', '알려줘', '찾아줘', '보여줘'
]);

/** 식별자(camelCase, PascalCase, snake_case)와 문장을 소문자 검색 토큰 배열로 분리한다. */
function tokenizeSearch(text: string): string[] {
    const expanded = text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return expanded
        .toLowerCase()
        .split(/[\s,.;:?!()[\]{}"'`/\\_\-+*=<>|&~@#$%^]+/)
        .filter(t => t.length >= 2);
}

/** 코드 그래프에 대한 심볼 검색·호출 추적·서브그래프 탐색·구조 분석 도구를 제공한다. */
export class GraphTools {
    private cachedExport: {
        data: GraphData;
        symbols: GraphData['symbols'];
        relations: GraphData['relations'];
        symbolCount: number;
        relationCount: number;
        root: string;
        exported: ReturnType<typeof buildExportedGraph>;
    } | null = null;

    /** 그래프 데이터 공급자와 선택적 루트 경로를 연결한다. */
    constructor(private getGraphData: () => GraphData, private getWorkspaceRoot: () => string = () => '') {}

    /** 동일한 그래프 스냅샷과 루트에 대해 내보내기 그래프(커뮤니티·핵심 노드 등)를 캐시해 재사용한다. */
    private getExportedGraph() {
        const data = this.getGraphData();
        const root = this.getWorkspaceRoot();
        const symbolCount = Object.keys(data.symbols).length;
        const relationCount = Object.keys(data.relations).length;
        if (
            this.cachedExport &&
            this.cachedExport.data === data &&
            this.cachedExport.symbols === data.symbols &&
            this.cachedExport.relations === data.relations &&
            this.cachedExport.symbolCount === symbolCount &&
            this.cachedExport.relationCount === relationCount &&
            this.cachedExport.root === root
        ) {
            return this.cachedExport.exported;
        }
        const exported = buildExportedGraph(data, root);
        this.cachedExport = { data, symbols: data.symbols, relations: data.relations, symbolCount, relationCount, root, exported };
        return exported;
    }

    /** 이름이나 식별자 패턴으로 심볼을 검색하고 일치도 순으로 반환한다. */
    public searchSymbols(query: string, maxNodes: number = 30): SymbolInfo[] {
        const data = this.getGraphData();
        const lowerQuery = query.toLowerCase().trim();
        const scored: Array<{ score: number; sym: SymbolInfo }> = [];

        for (const id in data.symbols) {
            const sym = data.symbols[id];
            const lowerName = sym.name.toLowerCase();
            const lowerId = id.toLowerCase();
            if (lowerName === lowerQuery) {
                scored.push({ score: 100, sym });
            } else if (lowerName.startsWith(lowerQuery)) {
                scored.push({ score: 80, sym });
            } else if (lowerName.includes(lowerQuery)) {
                scored.push({ score: 60, sym });
            } else if (lowerId.includes(lowerQuery)) {
                scored.push({ score: 40, sym });
            }
        }
        scored.sort((a, b) => b.score - a.score || a.sym.id.localeCompare(b.sym.id));
        return scored.slice(0, maxNodes).map(item => item.sym);
    }

    /** 정확한 ID·접미사·포터블 ID·이름 순으로 단일 심볼 정보를 찾는다. */
    public getSymbolInfo(symbolName: string): SymbolInfo | null {
        const data = this.getGraphData();
        if (data.symbols[symbolName]) {
            return data.symbols[symbolName];
        }
        for (const id in data.symbols) {
            if (id.endsWith(`::${symbolName}`)) {
                return data.symbols[id];
            }
        }
        // query_graph·get_god_nodes 등이 반환하는 포터블 ID(예: src/a.ts::Foo) 및 슬래시 정규화 경로를 지원한다.
        const norm = symbolName.trim().replace(/\\/g, '/');
        if (norm.includes('/') || norm.includes('::')) {
            const root = this.getWorkspaceRoot();
            for (const id in data.symbols) {
                const normId = id.replace(/\\/g, '/');
                if (normId === norm || normId.endsWith(`/${norm}`) || normId.endsWith(`::${norm}`) || (root && portableId(id, root) === norm)) {
                    return data.symbols[id];
                }
            }
        }
        for (const id in data.symbols) {
            if (data.symbols[id].name === symbolName) {
                return data.symbols[id];
            }
        }
        return null;
    }

    /** 특정 심볼 또는 파일(절대·상대 경로 모두 지원)이 의존하는 모든 관계를 반환한다. */
    public getDependencies(target: string): Relation[] {
        const data = this.getGraphData();
        const results: Relation[] = [];
        const targetSym = this.getSymbolInfo(target);
        const normTarget = target.trim().replace(/\\/g, '/');
        const root = this.getWorkspaceRoot();
        const allFiles = data.files?.length ? data.files : Object.values(data.symbols).map(symbol => symbol.filePath);
        const matchedFile = allFiles.find(file => {
            const normFile = file.replace(/\\/g, '/');
            return file === target || normFile === normTarget || normFile.endsWith(`/${normTarget}`) || (root !== '' && portableId(file, root) === normTarget);
        });
        if (!targetSym && !matchedFile) return results;

        for (const id in data.relations) {
            const rel = data.relations[id];
            if (matchedFile ? rel.sourceId === matchedFile || rel.sourceId.startsWith(`${matchedFile}::`)
                : rel.sourceId === targetSym!.id || rel.sourceId === targetSym!.filePath) {
                results.push(rel);
            }
        }
        return results;
    }

    /** 대상 심볼을 호출하는 모든 관계를 반환한다. */
    public getCallers(target: string): Relation[] {
        const data = this.getGraphData();
        const results: Relation[] = [];
        const targetSym = this.getSymbolInfo(target);
        const targetName = targetSym ? targetSym.name : target.split('::').pop() || target;

        for (const id in data.relations) {
            const rel = data.relations[id];
            if (rel.kind === 'call' && (
                rel.targetId === target ||
                (targetSym && rel.targetId === targetSym.id) ||
                (!target.includes('::') && (rel.targetId.endsWith(`::${target}`) || rel.targetId === `unknown::${targetName}`))
            )) {
                results.push(rel);
            }
        }
        return results;
    }

    /** 대상 심볼이 호출하는 모든 함수 관계를 반환한다. */
    public getCallees(target: string): Relation[] {
        const data = this.getGraphData();
        const results: Relation[] = [];
        const targetSym = this.getSymbolInfo(target);
        if (!targetSym) return results;

        for (const id in data.relations) {
            const rel = data.relations[id];
            if (rel.kind === 'call' && rel.sourceId === targetSym.id) {
                results.push(rel);
            }
        }
        return results;
    }

    /** 대상 심볼(클래스 멤버·오버라이드 메서드·타입 참조 포함) 변경 시 직·간접적으로 영향받는 상위 심볼을 최대 깊이까지 추적한다. */
    public getImpact(target: string, maxDepth: number = 3): SymbolInfo[] {
        const data = this.getGraphData();
        const impact: SymbolInfo[] = [];
        const visited = new Set<string>();
        const incoming = new Map<string, Relation[]>();
        const supertypes = new Map<string, string[]>();
        for (const relation of Object.values(data.relations)) {
            if (!['call', 'inherit', 'implement', 'reference'].includes(relation.kind)) continue;
            const edges = incoming.get(relation.targetId) || [];
            edges.push(relation);
            incoming.set(relation.targetId, edges);
            if (['inherit', 'implement'].includes(relation.kind) && data.symbols[relation.targetId]) {
                const parents = supertypes.get(relation.sourceId) || [];
                parents.push(relation.targetId);
                supertypes.set(relation.sourceId, parents);
            }
        }
        const startSym = this.getSymbolInfo(target);
        const queue: Array<{ targetKey: string; depth: number }> = [
            { targetKey: startSym ? startSym.id : target, depth: 0 }
        ];
        if (startSym) {
            visited.add(startSym.id);
            // 클래스나 인터페이스가 대상이면 소속 메서드·프로퍼티(depth 0 시드)에 대한 호출자도 변경 영향 범위에 포함한다(#1669).
            if (startSym.kind === 'class' || startSym.kind === 'interface') {
                const memberPrefix = `${startSym.id}::`;
                for (const symId in data.symbols) {
                    if (symId.startsWith(memberPrefix) && !visited.has(symId)) {
                        visited.add(symId);
                        queue.push({ targetKey: symId, depth: 0 });
                    }
                }
            }
        }

        /** 중첩 클래스·Python 메서드와 중간 구현이 없는 상속도 순환 없이 탐색한다. */
        const findOverriddenSuperMethods = (methodSymId: string): string[] => {
            const sym = data.symbols[methodSymId];
            if (!sym || !['function', 'method'].includes(sym.kind)) return [];
            const ownerClassId = methodSymId.slice(0, methodSymId.lastIndexOf('::'));
            if (!['class', 'interface'].includes(data.symbols[ownerClassId]?.kind)) return [];
            const results: string[] = [];
            const owners = [ownerClassId];
            const seen = new Set(owners);
            for (let head = 0; head < owners.length; head++) {
                for (const parent of supertypes.get(owners[head]) || []) {
                    if (seen.has(parent)) continue;
                    seen.add(parent);
                    owners.push(parent);
                    const superMethodId = `${parent}::${sym.name}`;
                    if (data.symbols[superMethodId]) results.push(superMethodId);
                }
            }
            return results;
        };

        for (let head = 0; head < queue.length; head++) {
            const { targetKey, depth } = queue[head];
            if (depth >= maxDepth) continue;

            const targets = [targetKey];
            for (const superMethodId of findOverriddenSuperMethods(targetKey)) {
                if (!visited.has(superMethodId)) {
                    visited.add(superMethodId);
                    targets.push(superMethodId);
                }
            }

            const edges = targets.flatMap(id => incoming.get(id) || []);
            // 심볼을 찾지 못한 짧은 이름 요청만 접미사 후보를 허용한다.
            const candidates = !startSym && !targetKey.includes('::')
                ? [...incoming.entries()].filter(([id]) => id.endsWith(`::${targetKey}`)).flatMap(([, relations]) => relations).concat(edges) : edges;
            for (const rel of candidates) {
                if (data.symbols[rel.sourceId] && !visited.has(rel.sourceId)) {
                    visited.add(rel.sourceId);
                    impact.push(data.symbols[rel.sourceId]);
                    queue.push({ targetKey: rel.sourceId, depth: depth + 1 });
                }
            }
        }
        return impact;
    }

    /** 가장 연결이 많은 핵심 추상화 심볼(God Nodes) 상위 목록을 반환한다. */
    public getGodNodes(topN: number = 10): GodNodeInfo[] {
        const exported = this.getExportedGraph();
        return exported.godNodes.slice(0, topN);
    }

    /** 탐지된 커뮤니티 요약과 특정 커뮤니티의 소속 노드를 반환한다. */
    public getCommunities(communityId?: number) {
        const exported = this.getExportedGraph();
        if (communityId !== undefined) {
            const community = exported.communities.find(c => c.id === communityId) || null;
            const members = exported.nodes.filter(n => n.community === communityId);
            return {
                totalCommunities: exported.communities.length,
                communities: community ? [community] : [],
                members
            };
        }
        return {
            totalCommunities: exported.communities.length,
            communities: exported.communities
        };
    }

    /** 불용어 제거·IDF 가중치·용어별 시드 보장으로 시드 노드를 선정한 뒤 BFS/DFS 서브그래프를 탐색한다. */
    public queryGraph(question: string, mode: 'bfs' | 'dfs' = 'bfs', depth: number = 3, maxNodes: number = 30) {
        maxNodes = Math.floor(maxNodes);
        if (!question.trim() || maxNodes <= 0) {
            return { question, mode, depth, seedNodes: [], nodes: [], links: [] };
        }
        const exported = this.getExportedGraph();
        const rawTokens = Array.from(new Set(tokenizeSearch(question)));
        const filteredTokens = rawTokens.filter(t => !QUERY_STOPWORDS.has(t));
        const terms = filteredTokens.length > 0 ? filteredTokens : rawTokens;
        const qFull = question.toLowerCase().trim();
        const totalNodes = Math.max(1, exported.nodes.length);

        // 희귀 식별자에 높은 가중치를 부여하기 위한 IDF 계산
        const idf = new Map<string, number>();
        for (const term of terms) {
            let df = 0;
            for (const node of exported.nodes) {
                if (node.norm_label.includes(term) || node.id.toLowerCase().includes(term)) df++;
            }
            idf.set(term, Math.log(1 + totalNodes / (1 + df)));
        }

        const bestByTerm = new Map<string, { score: number; node: ExportedNode }>();
        const scored = exported.nodes.map(node => {
            let score = 0;
            const label = node.norm_label;
            const labelTokens = tokenizeSearch(node.label);
            const id = node.id.toLowerCase();
            if (label === qFull || id === qFull || id.endsWith(`::${qFull}`)) score += 200;
            else if (label.startsWith(qFull)) score += 100;
            else if (label.includes(qFull) || id.includes(qFull)) score += 50;

            let matchedTerms = 0;
            for (const term of terms) {
                const w = idf.get(term) ?? 1;
                let termScore = 0;
                if (label === term) {
                    termScore = 60 * w;
                    matchedTerms++;
                } else if (labelTokens.includes(term) || label.startsWith(term)) {
                    termScore = 30 * w;
                    matchedTerms++;
                } else if (label.includes(term)) {
                    termScore = 15 * w;
                    matchedTerms++;
                } else if (id.includes(term)) {
                    termScore = 6 * w;
                }
                score += termScore;
                if (termScore > 0) {
                    const prev = bestByTerm.get(term);
                    if (!prev || termScore > prev.score) {
                        bestByTerm.set(term, { score: termScore, node });
                    }
                }
            }
            if (terms.length > 1 && matchedTerms > 1) {
                score *= 1 + (matchedTerms / terms.length);
            }
            return { node, score };
        }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));

        const seeds: ExportedNode[] = [];
        const seenSeedIds = new Set<string>();
        const seenSeedLabels = new Set<string>();
        for (const item of scored) {
            if (seeds.length >= Math.min(5, maxNodes)) break;
            if (seenSeedLabels.has(item.node.norm_label)) continue;
            seenSeedIds.add(item.node.id);
            seenSeedLabels.add(item.node.norm_label);
            seeds.push(item.node);
        }
        // 다중 키워드 질의 시 각 핵심어가 최소 1개 시드를 갖도록 보장(#1445)
        for (const { node } of bestByTerm.values()) {
            if (seeds.length >= Math.min(6, maxNodes)) break;
            if (!seenSeedIds.has(node.id) && !seenSeedLabels.has(node.norm_label)) {
                seenSeedIds.add(node.id);
                seenSeedLabels.add(node.norm_label);
                seeds.push(node);
            }
        }

        const nodeById = new Map<string, ExportedNode>(exported.nodes.map(n => [n.id, n]));
        const adj = new Map<string, string[]>();
        for (const n of exported.nodes) adj.set(n.id, []);
        for (const l of exported.links) {
            adj.get(l.source)?.push(l.target);
            adj.get(l.target)?.push(l.source);
        }

        const visited = new Set<string>(seeds.map(s => s.id));
        const frontier: Array<{ id: string; d: number }> = seeds.map(s => ({ id: s.id, d: 0 }));
        let head = 0;

        // BFS는 앞쪽 원소를 매번 이동하지 않고 읽기 위치만 전진시킨다.
        while ((mode === 'dfs' ? frontier.length > 0 : head < frontier.length) && visited.size < maxNodes) {
            const current = mode === 'dfs' ? frontier.pop()! : frontier[head++];
            if (current.d >= depth) continue;
            for (const nb of adj.get(current.id) || []) {
                if (!visited.has(nb)) {
                    visited.add(nb);
                    frontier.push({ id: nb, d: current.d + 1 });
                    if (visited.size >= maxNodes) break;
                }
            }
        }

        const subNodes = [...visited].map(id => nodeById.get(id)!).filter(Boolean);
        const subLinks = exported.links.filter(l => visited.has(l.source) && visited.has(l.target));
        return {
            question,
            mode,
            depth,
            seedNodes: seeds.map(s => s.id),
            nodes: subNodes,
            links: subLinks
        };
    }

    /** 두 심볼·파일 사이의 최단 연결 경로(의미 연결 우선 BFS, 필요 시 구조적 contains 폴백)를 탐색한다. */
    public findShortestPath(sourceQuery: string, targetQuery: string, maxHops: number = 8) {
        const exported = this.getExportedGraph();
        const resolveNode = (q: string): ExportedNode | undefined => {
            const trimmed = q.trim().replace(/\\/g, '/');
            const lower = trimmed.toLowerCase();
            return exported.nodes.find(n => n.id === trimmed) ||
                exported.nodes.find(n => n.id.toLowerCase() === lower) ||
                exported.nodes.find(n => n.id.endsWith(`::${trimmed}`) || n.id.endsWith(`/${trimmed}`)) ||
                exported.nodes.find(n => n.id.toLowerCase().endsWith(`::${lower}`) || n.id.toLowerCase().endsWith(`/${lower}`)) ||
                exported.nodes.find(n => n.label === trimmed) ||
                exported.nodes.find(n => n.norm_label === lower) ||
                exported.nodes.find(n => n.id.toLowerCase().includes(lower));
        };

        const srcNode = resolveNode(sourceQuery);
        const tgtNode = resolveNode(targetQuery);
        if (!srcNode || !tgtNode) {
            return { found: false, hops: -1, source: srcNode?.id || sourceQuery, target: tgtNode?.id || targetQuery, pathNodes: [], pathLinks: [] };
        }
        if (srcNode.id === tgtNode.id) {
            return { found: true, hops: 0, source: srcNode.id, target: tgtNode.id, pathNodes: [srcNode.id], pathLinks: [] };
        }

        const runBfs = (includeContains: boolean) => {
            const adj = new Map<string, Array<{ next: string; link: ExportedLink }>>();
            for (const n of exported.nodes) adj.set(n.id, []);
            for (const link of exported.links) {
                if (!includeContains && link.relation === 'contains') continue;
                adj.get(link.source)?.push({ next: link.target, link });
                adj.get(link.target)?.push({ next: link.source, link });
            }

            const queue: string[] = [srcNode.id];
            const prev = new Map<string, { from: string; link: ExportedLink }>();
            const dist = new Map<string, number>([[srcNode.id, 0]]);

            for (let head = 0; head < queue.length; head++) {
                const cur = queue[head];
                const d = dist.get(cur)!;
                if (cur === tgtNode.id) break;
                if (d >= maxHops) continue;

                for (const edge of adj.get(cur) || []) {
                    if (!dist.has(edge.next)) {
                        dist.set(edge.next, d + 1);
                        prev.set(edge.next, { from: cur, link: edge.link });
                        queue.push(edge.next);
                    }
                }
            }
            return { dist, prev };
        };

        // 파일 노드 자체가 출발/도착이 아닌 경우 의미적(호출·참조·상속·메서드·임포트) 경로를 먼저 탐색한다.
        const endpointsAreFiles = srcNode.kind === 'file' || tgtNode.kind === 'file';
        let searchResult = !endpointsAreFiles ? runBfs(false) : runBfs(true);
        if (!searchResult.dist.has(tgtNode.id) && !endpointsAreFiles) {
            searchResult = runBfs(true);
        }

        const { dist, prev } = searchResult;
        if (!dist.has(tgtNode.id)) {
            return { found: false, hops: -1, source: srcNode.id, target: tgtNode.id, pathNodes: [], pathLinks: [] };
        }

        const pathNodes: string[] = [tgtNode.id];
        const pathLinks: ExportedLink[] = [];
        let cur = tgtNode.id;
        while (cur !== srcNode.id) {
            const step = prev.get(cur)!;
            pathLinks.unshift(step.link);
            pathNodes.unshift(step.from);
            cur = step.from;
        }
        return {
            found: true,
            hops: pathLinks.length,
            source: srcNode.id,
            target: tgtNode.id,
            pathNodes,
            pathLinks
        };
    }

    /** 프로젝트의 전체 심볼·관계·커뮤니티·핵심 노드 통계를 요약한다. */
    public getProjectOverview(): any {
        const data = this.getGraphData();
        const exported = this.getExportedGraph();
        const stats = {
            totalFiles: new Set(data.files || Object.values(data.symbols).map(s => s.filePath)).size,
            totalSymbols: Object.keys(data.symbols).length,
            totalRelations: Object.keys(data.relations).length,
            communitiesCount: exported.communities.length,
            topGodNodes: exported.godNodes.slice(0, 5),
            symbolKinds: {} as Record<string, number>
        };

        for (const id in data.symbols) {
            const kind = data.symbols[id].kind;
            stats.symbolKinds[kind] = (stats.symbolKinds[kind] || 0) + 1;
        }

        return stats;
    }
}
