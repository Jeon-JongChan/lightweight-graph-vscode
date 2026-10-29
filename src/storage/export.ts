import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GraphData } from '../common/types';
import { GraphCache } from './cache';

/** 내보낼 그래프 노드의 표준 구조이다. */
export interface ExportedNode {
    id: string;
    label: string;
    norm_label: string;
    file_type: 'code' | 'concept';
    source_file: string;
    source_location: string;
    kind: string;
    community: number;
    community_name: string;
    external?: boolean;
    type?: string;
}

/** 내보낼 그래프 링크의 표준 구조이다. */
export interface ExportedLink {
    source: string;
    target: string;
    key: string;
    relation: string;
    confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
    confidence_score: number;
    certainty: string;
    source_file: string;
    source_location: string;
    weight?: number;
}

/** 커뮤니티 요약 정보이다. */
export interface CommunitySummary {
    id: number;
    name: string;
    size: number;
    cohesion: number;
    hubSymbol: string;
    files: string[];
    sampleNodes: string[];
}

/** 핵심 노드(God Node) 분석 항목이다. */
export interface GodNodeInfo {
    id: string;
    label: string;
    kind: string;
    source_file: string;
    source_location: string;
    degree: number;
    inDegree: number;
    outDegree: number;
    community: number;
    community_name: string;
}

/** 의외의 연결(Surprising Connection) 분석 항목이다. */
export interface SurprisingConnection {
    source: string;
    target: string;
    relation: string;
    confidence: string;
    confidence_score: number;
    surpriseScore: number;
    reasons: string[];
}

/** 내부 식별자의 프로젝트 절대 경로를 모든 세그먼트에서 상대 경로로 바꾼다. */
export function portableId(id: string, root: string): string {
    if (!root) return id.replace(/\\/g, '/');
    return id.split('::').map(part => {
        if (path.isAbsolute(part)) {
            const rel = path.relative(root, part).split(path.sep).join('/');
            return rel.startsWith('..') ? path.basename(part) : rel;
        }
        return part.replace(/\\/g, '/');
    }).join('::');
}

/** 검색과 비교를 위해 라벨을 소문자 정규화한다. */
function normalizeLabel(label: string): string {
    return label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** 대상 프로젝트의 현재 Git HEAD 커밋 해시를 구한다. */
function getGitCommit(root: string): string | null {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim() || null;
    } catch {
        return null;
    }
}

/** GraphData에서 구조화된 노드·링크·커뮤니티·핵심 노드·지식 공백을 계산한다. */
export function buildExportedGraph(data: GraphData, root: string = '') {
    const nodes = new Map<string, ExportedNode>();
    const links: ExportedLink[] = [];
    const linkByTriple = new Map<string, ExportedLink>();

    const addLink = (link: ExportedLink) => {
        const tripleKey = `${link.source}\0${link.target}\0${link.relation}`;
        const existing = linkByTriple.get(tripleKey);
        if (existing) {
            existing.weight = (existing.weight || 1) + 1;
            if (link.confidence_score > existing.confidence_score) {
                existing.confidence_score = link.confidence_score;
                existing.confidence = link.confidence;
            }
            return;
        }
        link.weight = 1;
        linkByTriple.set(tripleKey, link);
        links.push(link);
    };

    // 1. 파일 수준 노드와 심볼 노드를 등록하고 구조적 포함(contains/method) 링크를 생성한다.
    const fileSet = new Set<string>();
    for (const file of data.files || []) fileSet.add(portableId(file, root));
    for (const symbol of Object.values(data.symbols)) {
        fileSet.add(portableId(symbol.filePath, root));
    }
    for (const rel of Object.values(data.relations)) {
        const srcFile = rel.sourceId.split('::')[0];
        if (srcFile && !srcFile.startsWith('unknown')) {
            fileSet.add(portableId(srcFile, root));
        }
    }

    for (const fileRel of [...fileSet].sort()) {
        const base = path.posix.basename(fileRel);
        nodes.set(fileRel, {
            id: fileRel,
            label: base,
            norm_label: normalizeLabel(base),
            file_type: 'code',
            source_file: fileRel,
            source_location: 'L1',
            kind: 'file',
            community: 0,
            community_name: ''
        });
    }

    for (const symbol of Object.values(data.symbols)) {
        const id = portableId(symbol.id, root);
        const fileRel = portableId(symbol.filePath, root);
        const startLine = symbol.range.start.line + 1;
        const endLine = symbol.range.end.line + 1;
        const loc = endLine > startLine ? `L${startLine}-L${endLine}` : `L${startLine}`;
        nodes.set(id, {
            id,
            label: symbol.name,
            norm_label: normalizeLabel(symbol.name),
            file_type: 'code',
            source_file: fileRel,
            source_location: loc,
            kind: symbol.kind,
            community: 0,
            community_name: ''
        });
    }

    for (const symbol of Object.values(data.symbols)) {
        const id = portableId(symbol.id, root);
        const fileRel = portableId(symbol.filePath, root);
        const parts = id.split('::');
        const parentId = parts.length > 2 ? parts.slice(0, -1).join('::') : fileRel;
        const ownerId = nodes.has(parentId) ? parentId : fileRel;
        if (nodes.has(ownerId) && ownerId !== id) {
            const relType = ownerId !== fileRel && (symbol.kind === 'method' || symbol.kind === 'function') ? 'method' : 'contains';
            addLink({
                source: ownerId,
                target: id,
                key: `${ownerId}::${relType}::${id}`,
                relation: relType,
                confidence: 'EXTRACTED',
                confidence_score: 1.0,
                certainty: 'EXTRACTED',
                source_file: fileRel,
                source_location: `L${symbol.range.start.line + 1}`
            });
        }
    }

    // 2. 추출·해석된 의미 관계(calls, imports, inherits, implements, references)를 추가한다.
    const relationNames: Record<string, string> = {
        call: 'calls',
        import: 'imports',
        inherit: 'inherits',
        implement: 'implements',
        reference: 'references'
    };

    for (const relation of Object.values(data.relations)) {
        const source = portableId(relation.sourceId, root);
        const target = portableId(relation.targetId, root);
        const srcFile = portableId(relation.sourceId.split('::')[0], root);

        if (!nodes.has(source)) {
            const label = source.split('::').pop() || source;
            nodes.set(source, {
                id: source,
                label,
                norm_label: normalizeLabel(label),
                file_type: 'code',
                source_file: nodes.has(srcFile) ? srcFile : '',
                source_location: relation.range ? `L${relation.range.start.line + 1}` : '',
                kind: 'reference',
                community: 0,
                community_name: ''
            });
            if (nodes.has(srcFile) && srcFile !== source) {
                addLink({
                    source: srcFile,
                    target: source,
                    key: `${srcFile}::contains::${source}`,
                    relation: 'contains',
                    confidence: 'EXTRACTED',
                    confidence_score: 1.0,
                    certainty: 'EXTRACTED',
                    source_file: srcFile,
                    source_location: relation.range ? `L${relation.range.start.line + 1}` : 'L1'
                });
            }
        }

        if (!nodes.has(target)) {
            const isUnknown = target.startsWith('unknown::');
            const isExternalImport = relation.kind === 'import' && !isUnknown;
            const label = isUnknown ? target.slice('unknown::'.length) : target;
            nodes.set(target, {
                id: target,
                label,
                norm_label: normalizeLabel(label),
                file_type: isExternalImport ? 'concept' : 'code',
                source_file: '',
                source_location: '',
                kind: isExternalImport ? 'module' : 'reference',
                community: 0,
                community_name: '',
                ...(isExternalImport ? { external: true, type: 'external' } : {})
            });
        }

        const isAmbiguous = relation.targetId.startsWith('unknown::') || relation.certainty === 'UNRESOLVED';
        const confidence = isAmbiguous ? 'AMBIGUOUS' : relation.certainty === 'EXTRACTED' ? 'EXTRACTED' : 'INFERRED';
        const confidence_score = relation.confidenceScore ?? (
            isAmbiguous ? 0.2 : relation.certainty === 'EXTRACTED' ? 1.0 : relation.certainty === 'RESOLVED' ? 0.95 : 0.75
        );

        addLink({
            source,
            target,
            key: portableId(relation.id, root),
            relation: relationNames[relation.kind] || relation.kind,
            confidence,
            confidence_score,
            certainty: relation.certainty,
            source_file: nodes.has(srcFile) ? srcFile : '',
            source_location: relation.range ? `L${relation.range.start.line + 1}` : ''
        });
    }

    // 3. 차수(degree) 계산 및 아키텍처 모듈 단위 커뮤니티 탐지를 수행한다.
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    const semanticInDegree = new Map<string, number>();
    const semanticOutDegree = new Map<string, number>();
    const semanticDegree = new Map<string, number>();
    const neighbors = new Map<string, Map<string, number>>();

    for (const id of nodes.keys()) {
        inDegree.set(id, 0);
        outDegree.set(id, 0);
        semanticInDegree.set(id, 0);
        semanticOutDegree.set(id, 0);
        semanticDegree.set(id, 0);
        neighbors.set(id, new Map());
    }

    for (const link of links) {
        outDegree.set(link.source, (outDegree.get(link.source) || 0) + 1);
        inDegree.set(link.target, (inDegree.get(link.target) || 0) + 1);
        if (link.relation !== 'contains') {
            semanticOutDegree.set(link.source, (semanticOutDegree.get(link.source) || 0) + 1);
            semanticInDegree.set(link.target, (semanticInDegree.get(link.target) || 0) + 1);
            semanticDegree.set(link.source, (semanticDegree.get(link.source) || 0) + 1);
            semanticDegree.set(link.target, (semanticDegree.get(link.target) || 0) + 1);
        }
        const targetNode = nodes.get(link.target);
        const isStub = link.target.startsWith('unknown::') || Boolean(targetNode?.external);
        const weight = isStub ? 0.1
            : link.relation === 'contains' ? 0.9
            : link.relation === 'method' ? 1.8
            : link.confidence === 'AMBIGUOUS' ? 0.2 : 2.2;
        const srcMap = neighbors.get(link.source)!;
        const tgtMap = neighbors.get(link.target)!;
        srcMap.set(link.target, (srcMap.get(link.target) || 0) + weight);
        tgtMap.set(link.source, (tgtMap.get(link.source) || 0) + weight);
    }

    // 디렉터리·모듈 결합이 반영되도록 파일 간 의미 연결을 먼저 전파한 뒤 전체 노드를 군집화한다.
    const labels = new Map<string, string>();
    const sortedNodeIds = [...nodes.keys()].sort();
    for (const id of sortedNodeIds) {
        const node = nodes.get(id)!;
        const dirGroup = node.source_file ? path.posix.dirname(node.source_file) : '';
        labels.set(id, dirGroup && dirGroup !== '.' ? dirGroup : (node.source_file || id));
    }

    for (let iter = 0; iter < 8; iter++) {
        let changed = false;
        for (const id of sortedNodeIds) {
            const adj = neighbors.get(id)!;
            if (adj.size === 0) continue;
            const scores = new Map<string, number>();
            for (const [nb, w] of adj.entries()) {
                const nbLabel = labels.get(nb)!;
                scores.set(nbLabel, (scores.get(nbLabel) || 0) + w);
            }
            let bestLabel = labels.get(id)!;
            let bestScore = -1;
            for (const [lbl, sc] of [...scores.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
                if (sc > bestScore) {
                    bestScore = sc;
                    bestLabel = lbl;
                }
            }
            if (bestLabel !== labels.get(id)) {
                labels.set(id, bestLabel);
                changed = true;
            }
        }
        if (!changed) break;
    }

    const groups = new Map<string, string[]>();
    for (const id of sortedNodeIds) {
        const lbl = labels.get(id)!;
        let list = groups.get(lbl);
        if (!list) {
            list = [];
            groups.set(lbl, list);
        }
        list.push(id);
    }

    const sortedGroups = [...groups.values()].sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
    const communities: CommunitySummary[] = [];
    const usedNames = new Map<string, number>();

    sortedGroups.forEach((memberIds, idx) => {
        const memberSet = new Set(memberIds);
        let internalEdges = 0;
        for (const link of links) {
            if (memberSet.has(link.source) && memberSet.has(link.target) && link.source !== link.target) {
                internalEdges++;
            }
        }
        const n = memberIds.length;
        const maxEdges = n <= 1 ? 1 : (n * (n - 1)) / 2;
        const cohesion = n <= 1 ? 1.0 : Math.min(1.0, Math.round((internalEdges / maxEdges) * 100) / 100);

        const primarySymbols = memberIds
            .map(id => nodes.get(id)!)
            .filter(node => ['class', 'interface', 'function', 'module'].includes(node.kind) && !node.external);
        const realSymbols = memberIds
            .map(id => nodes.get(id)!)
            .filter(node => node.kind !== 'file' && node.kind !== 'reference' && node.kind !== 'variable' && !node.external);
        const candidates = primarySymbols.length > 0 ? primarySymbols : (realSymbols.length > 0 ? realSymbols : memberIds.map(id => nodes.get(id)!));
        candidates.sort((a, b) => {
            const degDiff = (semanticDegree.get(b.id) || 0) - (semanticDegree.get(a.id) || 0);
            if (degDiff !== 0) return degDiff;
            const totalDiff = ((inDegree.get(b.id) || 0) + (outDegree.get(b.id) || 0)) - ((inDegree.get(a.id) || 0) + (outDegree.get(a.id) || 0));
            return totalDiff !== 0 ? totalDiff : a.label.localeCompare(b.label);
        });

        const hub = candidates[0];
        const baseName = hub ? hub.label : `커뮤니티 ${idx}`;
        const count = (usedNames.get(baseName) || 0) + 1;
        usedNames.set(baseName, count);
        const commName = count > 1 ? `${baseName} (${idx})` : baseName;

        const files = [...new Set(memberIds.map(id => nodes.get(id)!.source_file).filter(Boolean))].sort();
        for (const id of memberIds) {
            const node = nodes.get(id)!;
            node.community = idx;
            node.community_name = commName;
        }

        communities.push({
            id: idx,
            name: commName,
            size: n,
            cohesion,
            hubSymbol: hub ? hub.id : '',
            files,
            sampleNodes: candidates.slice(0, 8).map(c => c.label)
        });
    });

    // 4. God Nodes(핵심 추상화 노드): Graphify와 동일하게 클래스·인터페이스·최상위 함수를 우선하며 고유 의미 연결 수로 순위를 매긴다.
    const allRealSymbolNodes = [...nodes.values()]
        .filter(node => node.kind !== 'file' && node.kind !== 'reference' && node.kind !== 'variable' && !node.external && !node.id.startsWith('unknown::'));
    const topLevelAbstractions = allRealSymbolNodes.filter(node => node.kind !== 'method' && node.id.split('::').length <= 2);
    const godPool = topLevelAbstractions.length >= 5 ? topLevelAbstractions : allRealSymbolNodes;

    const godNodes: GodNodeInfo[] = godPool
        .map(node => {
            const inDeg = semanticInDegree.get(node.id) || 0;
            const outDeg = semanticOutDegree.get(node.id) || 0;
            return {
                id: node.id,
                label: node.label,
                kind: node.kind,
                source_file: node.source_file,
                source_location: node.source_location,
                degree: inDeg + outDeg,
                inDegree: inDeg,
                outDegree: outDeg,
                community: node.community,
                community_name: node.community_name
            };
        })
        .sort((a, b) => b.degree - a.degree || b.inDegree - a.inDegree || a.id.localeCompare(b.id));

    // 5. 의외의 연결(Surprising Connections): 단순 파일 임포트와 포함 관계를 제외하고 실제 심볼 간 교차 연결만 점수화한다.
    const surprisingConnections: SurprisingConnection[] = [];
    for (const link of links) {
        if (['contains', 'method', 'imports'].includes(link.relation)) continue;
        const u = nodes.get(link.source);
        const v = nodes.get(link.target);
        if (!u || !v) continue;
        if (u.kind === 'file' || v.kind === 'file' || u.external || v.external) continue;
        if (u.id.startsWith('unknown::') || v.id.startsWith('unknown::')) continue;
        if (!u.source_file || !v.source_file || u.source_file === v.source_file) continue;

        let score = 1;
        const reasons: string[] = [`파일 간 연결 (${u.source_file} → ${v.source_file})`];
        if (u.community !== v.community) {
            score += 2;
            reasons.push(`서로 다른 커뮤니티 연결 (${u.community_name} → ${v.community_name})`);
        }
        const degU = semanticDegree.get(u.id) || 0;
        const degV = semanticDegree.get(v.id) || 0;
        if (Math.min(degU, degV) <= 2 && Math.max(degU, degV) >= 5) {
            score += 1;
            const periph = degU <= 2 ? u.label : v.label;
            const hub = degU <= 2 ? v.label : u.label;
            reasons.push(`말단 심볼 \`${periph}\`이 핵심 허브 \`${hub}\`에 직접 연결됨`);
        }
        if (link.confidence === 'INFERRED') {
            score += 1;
            reasons.push('임포트·수신자·이름 기반 추론 연결');
        }
        surprisingConnections.push({
            source: link.source,
            target: link.target,
            relation: link.relation,
            confidence: link.confidence,
            confidence_score: link.confidence_score,
            surpriseScore: score,
            reasons
        });
    }
    surprisingConnections.sort((a, b) => b.surpriseScore - a.surpriseScore || a.source.localeCompare(b.source));

    // 6. 파일 간 순환 임포트(Import Cycles) 탐지
    const importAdj = new Map<string, string[]>();
    for (const link of links) {
        if (link.relation === 'imports' && fileSet.has(link.source) && fileSet.has(link.target)) {
            const list = importAdj.get(link.source) || [];
            list.push(link.target);
            importAdj.set(link.source, list);
        }
    }
    const importCycles: string[][] = [];
    const seenCycles = new Set<string>();
    for (const startFile of [...fileSet].sort()) {
        const stack: Array<{ current: string; path: string[] }> = [{ current: startFile, path: [startFile] }];
        while (stack.length > 0) {
            const { current, path: curPath } = stack.pop()!;
            for (const next of importAdj.get(current) || []) {
                if (next === startFile && curPath.length > 1) {
                    const cycleKey = [...curPath].sort().join('->');
                    if (!seenCycles.has(cycleKey)) {
                        seenCycles.add(cycleKey);
                        importCycles.push([...curPath, startFile]);
                    }
                } else if (!curPath.includes(next) && curPath.length < 6) {
                    stack.push({ current: next, path: [...curPath, next] });
                }
            }
        }
    }

    // 7. 지식 공백(고립 심볼) 및 모호한 관계 목록, 추천 질문 생성
    const isolatedSymbols = [...nodes.values()]
        .filter(n => (n.kind === 'function' || n.kind === 'class') && !n.external && (semanticDegree.get(n.id) || 0) === 0)
        .map(n => `${n.label} (${n.source_file}:${n.source_location})`);

    const ambiguousEdges = links.filter(l => l.confidence === 'AMBIGUOUS');

    const suggestedQuestions: string[] = [];
    if (godNodes.length > 0) {
        const top = godNodes[0];
        suggestedQuestions.push(`가장 연결이 집중된 핵심 추상화 \`${top.label}\` (${top.degree}개 연결, 커뮤니티 \`${top.community_name}\`)의 역할과 하위 의존성은 적절히 분리되어 있습니까?`);
    }
    if (surprisingConnections.length > 0) {
        const topSurprise = surprisingConnections[0];
        suggestedQuestions.push(`\`${topSurprise.source}\`에서 \`${topSurprise.target}\`으로 이어지는 교차 연결(${topSurprise.reasons.join(', ')})은 의도된 아키텍처 경로입니까?`);
    }
    if (ambiguousEdges.length > 0) {
        const sample = ambiguousEdges[0];
        suggestedQuestions.push(`\`${sample.source}\`에서 \`${sample.target}\`으로 향하는 모호한(AMBIGUOUS) 호출·참조의 실제 정의 대상은 무엇입니까?`);
    }
    if (isolatedSymbols.length > 0) {
        suggestedQuestions.push(`의미 연결이 없는 고립 심볼 ${isolatedSymbols.length}개(예: ${isolatedSymbols.slice(0, 2).join(', ')})는 외부 진입점입니까, 아니면 미사용 코드입니까?`);
    }
    if (communities.length > 1) {
        const lowest = [...communities].sort((a, b) => a.cohesion - b.cohesion)[0];
        suggestedQuestions.push(`응집도가 가장 낮은 커뮤니티 \`${lowest.name}\` (Cohesion ${lowest.cohesion}, 노드 ${lowest.size}개)를 더 작은 모듈로 분리할 수 있습니까?`);
    }

    const sortedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    const sortedLinks = [...links].sort((a, b) => a.key.localeCompare(b.key));

    return {
        nodes: sortedNodes,
        links: sortedLinks,
        communities,
        godNodes,
        surprisingConnections,
        importCycles,
        isolatedSymbols,
        ambiguousEdges,
        suggestedQuestions
    };
}

/** 오프라인에서도 즉시 동작하는 대화형 그래프 시각화 HTML을 생성한다. */
function generateGraphHtml(projectTitle: string, nodes: ExportedNode[], links: ExportedLink[], communities: CommunitySummary[]): string {
    const title = projectTitle.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const palette = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#2563eb', '#65a30d', '#ea580c'];
    const payload = JSON.stringify({ projectTitle, nodes, links, communities, palette }).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title} - 코드 그래프 시각화</title>
<style>
  :root { --bg: #0f172a; --panel: #1e293b; --text: #f8fafc; --muted: #94a3b8; --border: #334155; --accent: #38bdf8; }
  body.light { --bg: #f8fafc; --panel: #ffffff; --text: #0f172a; --muted: #475569; --border: #cbd5e1; --accent: #0284c7; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  header { background: var(--panel); border-bottom: 1px solid var(--border); padding: 10px 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; z-index: 2; }
  header h1 { font-size: 15px; font-weight: 600; margin-right: 8px; }
  input, select, button { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  button { cursor: pointer; }
  button:hover { border-color: var(--accent); }
  .stats { font-size: 12px; color: var(--muted); margin-left: auto; }
  main { flex: 1; display: flex; position: relative; overflow: hidden; }
  canvas { flex: 1; width: 100%; height: 100%; cursor: grab; }
  canvas:active { cursor: grabbing; }
  aside { width: 320px; background: var(--panel); border-left: 1px solid var(--border); padding: 14px; overflow-y: auto; font-size: 13px; display: flex; flex-direction: column; gap: 10px; }
  aside h2 { font-size: 14px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; background: var(--bg); border: 1px solid var(--border); margin-right: 4px; }
  ul { list-style: none; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
  li { padding: 4px 6px; border-radius: 4px; background: var(--bg); font-family: monospace; font-size: 11px; word-break: break-all; cursor: pointer; }
  li:hover { border-left: 2px solid var(--accent); }
</style>
</head>
<body>
<header>
  <h1>${title} 코드 그래프</h1>
  <input id="search" type="search" placeholder="심볼·파일 검색..." />
  <select id="commFilter"><option value="all">전체 커뮤니티</option></select>
  <select id="kindFilter">
    <option value="all">전체 종류</option>
    <option value="symbols">심볼만 (파일·스텁 제외)</option>
    <option value="file">파일만</option>
  </select>
  <button id="resetBtn" type="button">화면 맞춤</button>
  <button id="themeBtn" type="button">테마 전환</button>
  <span class="stats" id="statsText"></span>
</header>
<main>
  <canvas id="graphCanvas"></canvas>
  <aside id="inspector">
    <h2>노드 상세 정보</h2>
    <div id="nodeDetails">노드를 클릭하거나 검색하면 상세 연결과 소스 위치를 표시합니다.</div>
  </aside>
</main>
<script>
const DATA = ${payload};
const canvas = document.getElementById('graphCanvas');
const ctx = canvas.getContext('2d');
const searchInput = document.getElementById('search');
const commFilter = document.getElementById('commFilter');
const kindFilter = document.getElementById('kindFilter');
const statsText = document.getElementById('statsText');
const nodeDetails = document.getElementById('nodeDetails');

DATA.communities.forEach(c => {
  const opt = document.createElement('option');
  opt.value = String(c.id);
  opt.textContent = \`#\${c.id} \${c.name} (\${c.size})\`;
  commFilter.appendChild(opt);
});
statsText.textContent = \`노드 \${DATA.nodes.length}개 · 관계 \${DATA.links.length}개 · 커뮤니티 \${DATA.communities.length}개\`;

const degreeMap = new Map();
DATA.links.forEach(l => {
  degreeMap.set(l.source, (degreeMap.get(l.source) || 0) + 1);
  degreeMap.set(l.target, (degreeMap.get(l.target) || 0) + 1);
});

const simNodes = DATA.nodes.map((n, idx) => {
  const angle = (idx / Math.max(1, DATA.nodes.length)) * Math.PI * 2;
  const radius = 80 + (n.community * 45) + (idx % 17) * 8;
  return { ...n, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0, deg: degreeMap.get(n.id) || 1 };
});
const nodeById = new Map(simNodes.map(n => [n.id, n]));
const simLinks = DATA.links.map(l => ({ ...l, s: nodeById.get(l.source), t: nodeById.get(l.target) })).filter(l => l.s && l.t);

let camX = 0, camY = 0, scale = 1, selectedNode = null, dragNode = null, isPanning = false, startX = 0, startY = 0;

function isVisible(n) {
  if (commFilter.value !== 'all' && String(n.community) !== commFilter.value) return false;
  if (kindFilter.value === 'symbols' && (n.kind === 'file' || n.kind === 'reference' || n.external)) return false;
  if (kindFilter.value === 'file' && n.kind !== 'file') return false;
  const q = searchInput.value.trim().toLowerCase();
  if (q && !n.label.toLowerCase().includes(q) && !n.id.toLowerCase().includes(q)) return false;
  return true;
}

function stepPhysics() {
  for (let iter = 0; iter < 50; iter++) {
    for (let i = 0; i < simNodes.length; i++) {
      const a = simNodes[i];
      for (let j = i + 1; j < simNodes.length; j++) {
        const b = simNodes[j];
        const dx = b.x - a.x || 0.1, dy = b.y - a.y || 0.1;
        const d2 = dx * dx + dy * dy;
        if (d2 < 90000) {
          const f = 220 / Math.max(25, d2);
          a.vx -= dx * f; a.vy -= dy * f;
          b.vx += dx * f; b.vy += dy * f;
        }
      }
    }
    simLinks.forEach(l => {
      const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
      const dist = Math.hypot(dx, dy) || 1;
      const targetDist = l.relation === 'contains' ? 40 : 85;
      const f = (dist - targetDist) * 0.015;
      const fx = (dx / dist) * f, fy = (dy / dist) * f;
      l.s.vx += fx; l.s.vy += fy;
      l.t.vx -= fx; l.t.vy -= fy;
    });
    simNodes.forEach(n => {
      n.x += Math.max(-12, Math.min(12, n.vx));
      n.y += Math.max(-12, Math.min(12, n.vy));
      n.vx *= 0.65; n.vy *= 0.65;
    });
  }
}
stepPhysics();

function resize() {
  canvas.width = canvas.clientWidth * window.devicePixelRatio;
  canvas.height = canvas.clientHeight * window.devicePixelRatio;
  draw();
}
window.addEventListener('resize', resize);

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2 + camX * dpr, canvas.height / 2 + camY * dpr);
  ctx.scale(scale * dpr, scale * dpr);

  const visibleSet = new Set(simNodes.filter(isVisible).map(n => n.id));
  simLinks.forEach(l => {
    if (!visibleSet.has(l.s.id) || !visibleSet.has(l.t.id)) return;
    const highlight = selectedNode && (l.s.id === selectedNode.id || l.t.id === selectedNode.id);
    ctx.beginPath();
    ctx.moveTo(l.s.x, l.s.y);
    ctx.lineTo(l.t.x, l.t.y);
    ctx.strokeStyle = highlight ? '#38bdf8' : (l.confidence === 'AMBIGUOUS' ? 'rgba(244,63,94,0.45)' : 'rgba(148,163,184,0.28)');
    ctx.lineWidth = highlight ? 2 : 1;
    ctx.stroke();
  });

  simNodes.forEach(n => {
    if (!visibleSet.has(n.id)) return;
    const r = Math.min(16, 4.5 + Math.sqrt(n.deg) * 1.4);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = DATA.palette[n.community % DATA.palette.length];
    ctx.fill();
    if (selectedNode && selectedNode.id === n.id) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#38bdf8';
      ctx.stroke();
    }
    ctx.fillStyle = document.body.classList.contains('light') ? '#0f172a' : '#e2e8f0';
    ctx.font = '11px sans-serif';
    ctx.fillText(n.label, n.x + r + 3, n.y + 3);
  });
  ctx.restore();
}

/** 소스 문자열이 HTML 태그 또는 관계 링크의 속성으로 해석되지 않게 한다. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function selectNode(n) {
  selectedNode = n;
  if (!n) {
    nodeDetails.textContent = '노드를 클릭하거나 검색하면 상세 연결과 소스 위치를 표시합니다.';
    draw();
    return;
  }
  const outgoing = DATA.links.filter(l => l.source === n.id);
  const incoming = DATA.links.filter(l => l.target === n.id);
  nodeDetails.innerHTML = \`
    <div><span class="badge">\${escapeHtml(n.kind)}</span><span class="badge">커뮤니티 #\${n.community}: \${escapeHtml(n.community_name)}</span></div>
    <div style="margin-top:6px;font-weight:600;word-break:break-all;">\${escapeHtml(n.label)}</div>
    <div style="font-size:11px;color:var(--muted);margin-top:2px;word-break:break-all;">ID: \${escapeHtml(n.id)}</div>
    <div style="font-size:11px;color:var(--muted);">위치: \${escapeHtml(n.source_file || '외부/미해결')} \${escapeHtml(n.source_location || '')}</div>
    <h2 style="margin-top:10px;">나가는 관계 (\${outgoing.length})</h2>
    <ul>\${outgoing.map(l => \`<li data-id="\${escapeHtml(l.target)}">[\${escapeHtml(l.relation)}] → \${escapeHtml(l.target)} (\${escapeHtml(l.confidence)})</li>\`).join('') || '<li>없음</li>'}</ul>
    <h2 style="margin-top:10px;">들어오는 관계 (\${incoming.length})</h2>
    <ul>\${incoming.map(l => \`<li data-id="\${escapeHtml(l.source)}">[\${escapeHtml(l.relation)}] ← \${escapeHtml(l.source)} (\${escapeHtml(l.confidence)})</li>\`).join('') || '<li>없음</li>'}</ul>
  \`;
  nodeDetails.querySelectorAll('li[data-id]').forEach(li => {
    li.addEventListener('click', () => {
      const target = nodeById.get(li.getAttribute('data-id'));
      if (target) { camX = -target.x * scale; camY = -target.y * scale; selectNode(target); }
    });
  });
  draw();
}

canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const wx = (e.clientX - rect.left - canvas.clientWidth / 2 - camX) / scale;
  const wy = (e.clientY - rect.top - canvas.clientHeight / 2 - camY) / scale;
  const hit = simNodes.filter(isVisible).find(n => Math.hypot(n.x - wx, n.y - wy) < 12);
  if (hit) { dragNode = hit; selectNode(hit); }
  else { isPanning = true; startX = e.clientX - camX; startY = e.clientY - camY; }
});
window.addEventListener('mousemove', e => {
  if (dragNode) {
    const rect = canvas.getBoundingClientRect();
    dragNode.x = (e.clientX - rect.left - canvas.clientWidth / 2 - camX) / scale;
    dragNode.y = (e.clientY - rect.top - canvas.clientHeight / 2 - camY) / scale;
    draw();
  } else if (isPanning) {
    camX = e.clientX - startX; camY = e.clientY - startY; draw();
  }
});
window.addEventListener('mouseup', () => { dragNode = null; isPanning = false; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  scale = Math.max(0.2, Math.min(4, scale * (e.deltaY < 0 ? 1.12 : 0.9)));
  draw();
}, { passive: false });
[searchInput, commFilter, kindFilter].forEach(el => el.addEventListener('input', draw));
document.getElementById('resetBtn').addEventListener('click', () => { camX = 0; camY = 0; scale = 1; draw(); });
document.getElementById('themeBtn').addEventListener('click', () => { document.body.classList.toggle('light'); draw(); });
resize();
</script>
</body>
</html>`;
}

/** Graphify 호환 노드·링크 JSON, 상세 분석 리포트(GRAPH_REPORT.md), 대화형 시각화(graph.html)를 내보낸다. */
export async function writeGraphExport(root: string, data: GraphData, parseErrorCount: number) {
    const directory = path.dirname(new GraphCache(root).getCachePath());
    const exported = buildExportedGraph(data, root);
    const commit = getGitCommit(root);
    const graphMeta: Record<string, unknown> = {
        producer: 'lightweight-graph-mcp',
        schema_version: 'lightweight-graph-mcp/2',
        ...(commit ? { built_at_commit: commit } : {})
    };
    const graph = {
        directed: true,
        multigraph: true,
        graph: graphMeta,
        nodes: exported.nodes,
        links: exported.links,
        hyperedges: []
    };

    const extractedCount = exported.links.filter(l => l.confidence === 'EXTRACTED').length;
    const inferredCount = exported.links.filter(l => l.confidence === 'INFERRED').length;
    const ambiguousCount = exported.links.filter(l => l.confidence === 'AMBIGUOUS').length;
    const totalLinks = Math.max(1, exported.links.length);
    const avgScore = exported.links.length
        ? (exported.links.reduce((acc, l) => acc + l.confidence_score, 0) / exported.links.length).toFixed(2)
        : '1.00';

    const reportLines: string[] = [
        `# 프로젝트 코드 그래프 리포트 (${path.basename(root)})`,
        '',
        `- 생성 시각: ${new Date().toISOString()} (UTC)`,
        ...(commit ? [`- Git 커밋(built_at_commit): \`${commit}\``] : []),
        '',
        '## 요약',
        `- 전체 노드: ${exported.nodes.length}개 (심볼 ${Object.keys(data.symbols).length}개, 파일 ${exported.nodes.filter(n => n.kind === 'file').length}개)`,
        `- 전체 관계(링크): ${exported.links.length}개`,
        `  - EXTRACTED (구문 직접 추출): ${extractedCount}개 (${Math.round((extractedCount / totalLinks) * 100)}%)`,
        `  - INFERRED (파일·임포트·수신자·이름 기반 해석): ${inferredCount}개 (${Math.round((inferredCount / totalLinks) * 100)}%)`,
        `  - AMBIGUOUS (미해결·다중 후보): ${ambiguousCount}개 (${Math.round((ambiguousCount / totalLinks) * 100)}%)`,
        `- 평균 관계 신뢰도 점수(confidence_score): ${avgScore}`,
        `- 탐지된 커뮤니티: ${exported.communities.length}개`,
        `- 구문 오류 또는 부분 지원 문법 파일: ${parseErrorCount}개`,
        '',
        '## 핵심 추상화 (God Nodes)',
        ...(exported.godNodes.length
            ? exported.godNodes.slice(0, 10).map((g, idx) =>
                `${idx + 1}. \`${g.label}\` (${g.kind}, \`${g.source_file}:${g.source_location}\`) — 연결 ${g.degree}개 (유입 ${g.inDegree}, 유출 ${g.outDegree}) · 커뮤니티: ${g.community_name}`)
            : ['- 추출된 핵심 심볼이 없습니다.']),
        '',
        '## 의외의 연결 (Surprising Connections)',
        ...(exported.surprisingConnections.length
            ? exported.surprisingConnections.slice(0, 10).map(s =>
                `- \`${s.source}\` --[${s.relation} (${s.confidence}, ${s.confidence_score})]--> \`${s.target}\` (${s.reasons.join(', ')})`)
            : ['- 파일·커뮤니티 경계를 넘는 특이 연결이 없습니다.']),
        '',
        '## 순환 임포트 (Import Cycles)',
        ...(exported.importCycles.length
            ? exported.importCycles.map(cycle => `- ${cycle.map(f => `\`${f}\``).join(' → ')}`)
            : ['- 탐지된 파일 간 순환 임포트가 없습니다.']),
        '',
        '## 커뮤니티 (Communities)',
        ...(exported.communities.length
            ? exported.communities.slice(0, 15).map(c =>
                `### 커뮤니티 #${c.id}: ${c.name}\n- 노드 수: ${c.size}개 · 응집도(Cohesion): ${c.cohesion}\n- 주요 파일: ${c.files.slice(0, 5).join(', ') || '외부/공통'}\n- 대표 노드: ${c.sampleNodes.join(', ')}`)
            : ['- 커뮤니티 정보가 없습니다.']),
        '',
        '## 확인이 필요한 관계 (Ambiguous Edges)',
        ...(exported.ambiguousEdges.length
            ? exported.ambiguousEdges.slice(0, 15).map(e =>
                `- \`${e.source}\` --[${e.relation}]--> \`${e.target}\` (${e.source_file || '출처 미상'} ${e.source_location})`)
            : ['- 미해결(AMBIGUOUS) 관계가 없습니다.']),
        '',
        '## 지식 공백 (Knowledge Gaps)',
        ...(exported.isolatedSymbols.length
            ? [`- 호출·상속 관계가 없는 고립 심볼 (${exported.isolatedSymbols.length}개): ${exported.isolatedSymbols.slice(0, 15).join(', ')}`]
            : ['- 모든 심볼이 최소 1개 이상의 의미 관계로 연결되어 있습니다.']),
        '',
        '## 추천 질문 (Suggested Questions)',
        ...exported.suggestedQuestions.map(q => `- ${q}`),
        ''
    ];

    const graphPath = path.join(directory, 'graph.json');
    const reportPath = path.join(directory, 'GRAPH_REPORT.md');
    const htmlPath = path.join(directory, 'graph.html');
    const htmlContent = generateGraphHtml(path.basename(root), exported.nodes, exported.links, exported.communities);

    fs.mkdirSync(directory, { recursive: true });
    for (const [file, content] of [
        [graphPath, JSON.stringify(graph, null, 2)],
        [reportPath, reportLines.join('\n')],
        [htmlPath, htmlContent]
    ] as const) {
        await fs.promises.writeFile(`${file}.tmp`, content, 'utf8');
        await fs.promises.rename(`${file}.tmp`, file);
    }
    return { graphPath, reportPath, htmlPath };
}
