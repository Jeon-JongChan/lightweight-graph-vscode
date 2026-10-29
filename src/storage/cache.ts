import * as fs from 'fs';
import * as path from 'path';
import { GraphData, Relation } from '../common/types';

/** 해석 결과와 원시 관계에 동일한 캐시 입력 검증을 적용한다. */
function isRelationRecord(value: unknown): value is Record<string, Relation> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
        Object.entries(value).every(([id, relation]) => relation && relation.id === id &&
            typeof relation.sourceId === 'string' && typeof relation.targetId === 'string' &&
            (relation.receiver === undefined || typeof relation.receiver === 'string') &&
            (relation.bindingScope === undefined || typeof relation.bindingScope === 'string') &&
            (relation.lexicalBinding === undefined || typeof relation.lexicalBinding === 'string') &&
            (relation.bindings === undefined || (relation.bindings && typeof relation.bindings === 'object' && !Array.isArray(relation.bindings) &&
                Object.values(relation.bindings).every(name => typeof name === 'string'))) &&
            ['call', 'import', 'inherit', 'implement', 'reference'].includes(relation.kind) &&
            ['EXTRACTED', 'RESOLVED', 'INFERRED', 'UNRESOLVED'].includes(relation.certainty)));
}

/** 프로젝트 그래프를 공통 경로에 저장하고 이전 캐시를 읽는다. */
export class GraphCache {
    private cachePath: string;
    private legacyPath: string;

    /** 새 저장 경로와 읽기 전용 호환 경로를 정한다. */
    constructor(workspaceRoot: string) {
        this.cachePath = path.join(workspaceRoot, '.tools', '.graphify', 'graph-cache.json');
        this.legacyPath = path.join(workspaceRoot, '.mcp', 'graph-cache.json');
    }

    /** 생성·삭제 대상인 새 캐시 경로를 반환한다. */
    public getCachePath(): string {
        return this.cachePath;
    }

    /** 기존 캐시를 보존하면서 완성된 JSON으로 교체한다. */
    public async save(data: GraphData): Promise<void> {
        fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
        const temporaryPath = `${this.cachePath}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(temporaryPath, this.cachePath);
    }

    /** 새 캐시가 없을 때만 이전 경로를 읽고 잘못된 구조를 거부한다. */
    public async load(): Promise<GraphData | null> {
        try {
            let content: string;
            try {
                content = await fs.promises.readFile(this.cachePath, 'utf-8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                content = await fs.promises.readFile(this.legacyPath, 'utf-8');
            }
            const data = JSON.parse(content) as GraphData;
            if (data && data.version === '1.0' && data.symbols && data.relations &&
                typeof data.symbols === 'object' && !Array.isArray(data.symbols) &&
                isRelationRecord(data.relations) &&
                (data.extractedRelations === undefined || isRelationRecord(data.extractedRelations)) &&
                Object.values(data.symbols).every(symbol => symbol && typeof symbol.id === 'string' &&
                    typeof symbol.name === 'string' && typeof symbol.filePath === 'string')) {
                return data;
            } else {
                console.error('Graph MCP: 캐시 형식이 올바르지 않습니다. 다시 생성하세요.');
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Graph MCP: 캐시를 읽지 못했습니다.', error);
        }
        return null;
    }

    /** 이전 캐시로 되돌아가지 않도록 빈 스냅샷으로 초기화한다. */
    public async clear(): Promise<void> {
        await this.save({ version: '1.0', symbols: {}, relations: {} });
    }
}
