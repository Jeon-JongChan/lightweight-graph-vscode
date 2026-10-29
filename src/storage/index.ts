import * as fs from 'fs';
import { GraphData, Relation, SymbolInfo } from '../common/types';
import { CodeParser } from '../core/parser';
import { analyzeFile } from '../core/analyzers';
import { GraphCache } from './cache';
import { ImportResolver } from '../core/imports';
import { RelationResolver } from '../core/resolution';
import * as path from 'path';

/** 파일 내용이 변경되지 않았을 때 Tree-sitter WASM 재파싱을 건너뛰기 위한 프로세스 내 AST 캐시이다. */
const rawAstCache = new Map<string, {
    content: string;
    hasError: boolean;
    symbols: SymbolInfo[];
    relations: Relation[];
}>();

/** AST에서 추출한 프로젝트 심볼과 관계를 관리한다. */
export class GraphIndex {
    private data: GraphData;
    private cache: GraphCache;
    private parser = new CodeParser();
    private extensionPath?: string;
    private parseErrorFiles = new Set<string>();
    private workspaceRoot: string;
    private indexedContents = new Map<string, string>();

    /** 프로젝트 캐시와 파서의 자산 경로를 설정한다. */
    constructor(workspaceRoot: string, extensionPath?: string) {
        this.workspaceRoot = workspaceRoot;
        this.cache = new GraphCache(workspaceRoot);
        this.data = { version: '1.0', files: [], symbols: {}, relations: {}, extractedRelations: {} };
        this.extensionPath = extensionPath;
    }

    /** 파서를 준비하고 필요할 때 기존 스냅샷을 읽는다. */
    public async initialize(loadCache = true): Promise<void> {
        await this.parser.initialize(this.extensionPath, []);
        const loaded = loadCache ? await this.cache.load() : null;
        if (loaded) {
            this.data = loaded;
            this.data.files ||= [...new Set([...Object.values(loaded.symbols).map(symbol => symbol.filePath),
                ...Object.values(loaded.relations).map(relation => relation.sourceId.split('::')[0])])];
            if (!loaded.extractedRelations) {
                // 이전 캐시의 해석 결과를 원시 사실로 오인하지 않고 프로젝트 내부 소스에서 복원한다.
                const files = new Set([...Object.values(loaded.symbols).map(symbol => symbol.filePath),
                    ...Object.values(loaded.relations).map(relation => relation.sourceId.split('::')[0])]);
                this.data = { version: '1.0', files: [], symbols: {}, relations: {}, extractedRelations: {} };
                const realRoot = fs.realpathSync(this.workspaceRoot);
                for (const file of files) {
                    const relative = path.relative(realRoot, path.resolve(file));
                    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.existsSync(file)) continue;
                    const realRelative = path.relative(realRoot, fs.realpathSync(file));
                    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) continue;
                    await this.updateFile(file, true);
                }
                this.resolveRelations();
            }
        }
    }

    /** 파일을 파싱한 뒤 기존 항목을 교체하며 실패는 호출자에게 전달한다. */
    public async updateFile(filePath: string, skipSave: boolean = false): Promise<void> {
        const language = CodeParser.getLanguageFromFile(filePath);
        if (!language) return;

        try {
            // DMI는 PNG의 텍스트 메타데이터만 읽으며 바이너리 바이트를 손실 없이 전달한다.
            const content = await fs.promises.readFile(filePath, language === 'dmi' ? 'latin1' : 'utf-8');
            // 현재 인스턴스에서 확인한 파일만 생략한다. 디스크 캐시의 신선도는 추정하지 않는다.
            if (this.indexedContents.get(filePath) === content) {
                if (!skipSave) {
                    this.resolveRelations();
                    await this.cache.save(this.data);
                }
                return;
            }
            const cached = rawAstCache.get(filePath);
            if (cached && cached.content === content) {
                this.removeFileEntries(filePath);
                this.data.files!.push(filePath);
                if (cached.hasError) this.parseErrorFiles.add(filePath);
                for (const sym of cached.symbols) {
                    this.data.symbols[sym.id] = { ...sym };
                }
                for (const rel of cached.relations) {
                    this.data.relations[rel.id] = { ...rel };
                    this.data.extractedRelations![rel.id] = { ...rel };
                }
                this.indexedContents.set(filePath, content);
                if (!skipSave) {
                    this.resolveRelations();
                    await this.cache.save(this.data);
                }
                return;
            }

            await this.parser.initialize(this.extensionPath, [language]);
            const { symbols, relations, hasError } = analyzeFile(language, content, filePath, this.parser);
            if (rawAstCache.size > 2000) rawAstCache.clear();
            rawAstCache.set(filePath, {
                content,
                hasError,
                symbols: symbols.map(s => ({ ...s })),
                relations: relations.map(r => ({ ...r }))
            });
            this.removeFileEntries(filePath);
            this.data.files!.push(filePath);
            if (hasError) this.parseErrorFiles.add(filePath);

            // 키가 같은 중복 선언은 하나로 합친다.
            for (const sym of symbols) {
                this.data.symbols[sym.id] = sym;
            }
            for (const rel of relations) {
                this.data.relations[rel.id] = { ...rel };
                this.data.extractedRelations![rel.id] = { ...rel };
            }
            this.indexedContents.set(filePath, content);

            if (!skipSave) {
                this.resolveRelations();
                await this.cache.save(this.data);
            }
        } catch (error) {
            throw new Error(`파일 색인 실패: ${filePath}`, { cause: error });
        }
    }

    /** 완성된 스냅샷을 저장한다. */
    public async saveCache(): Promise<void> {
        await this.cache.save(this.data);
    }

    /** 파일의 심볼과 관계를 제거한 스냅샷을 저장한다. */
    public async removeFile(filePath: string): Promise<void> {
        this.removeFileEntries(filePath);
        this.resolveRelations();
        await this.cache.save(this.data);
    }

    /** 메모리에서 특정 파일에 속한 항목을 제거한다. */
    private removeFileEntries(filePath: string) {
        this.indexedContents.delete(filePath);
        // 새 스냅샷에 처음 추가되는 파일은 기존 전체 그래프를 순회할 필요가 없다.
        if (!this.data.files?.includes(filePath)) return;
        this.data.files = this.data.files?.filter(file => file !== filePath) || [];
        this.parseErrorFiles.delete(filePath);
        for (const id in this.data.symbols) {
            if (this.data.symbols[id].filePath === filePath) {
                delete this.data.symbols[id];
            }
        }
        for (const id in this.data.relations) {
            const rel = this.data.relations[id];
            // 대상 파일을 갱신할 때 다른 파일이 선언한 임포트·호출까지 지우면 안 된다.
            if (rel.sourceId === filePath || rel.sourceId.startsWith(`${filePath}::`) || rel.id.startsWith(`${filePath}::`)) {
                delete this.data.relations[id];
            }
        }
        for (const [id, relation] of Object.entries(this.data.extractedRelations || {})) {
            if (relation.sourceId === filePath || relation.sourceId.startsWith(`${filePath}::`)) {
                delete this.data.extractedRelations![id];
            }
        }
    }

    /** 원시 사실에서 다시 시작하여 임포트 어댑터로 파일 대상을 연결한다. */
    public resolveImports(): void {
        if (this.data.extractedRelations) {
            this.data.relations = Object.fromEntries(Object.entries(this.data.extractedRelations).map(([id, relation]) => [id, { ...relation }]));
        }
        new ImportResolver(this.data, this.workspaceRoot).resolve();
    }

    /** 공유 전략 체인으로 현재 심볼의 관계를 해석한다. */
    public resolveRelations(): void {
        this.resolveImports();
        new RelationResolver(this.data).resolve();
    }

    /** 현재 메모리의 그래프를 반환한다. */
    public getGraphData(): GraphData {
        return this.data;
    }

    /** 문법 오류 또는 미지원 방언 구문이 있었던 파일을 반환한다. */
    public getParseErrorFiles(): string[] {
        return [...this.parseErrorFiles];
    }

    /** 캐시를 빈 그래프로 초기화한다. */
    public async clear(): Promise<void> {
        this.data = { version: '1.0', files: [], symbols: {}, relations: {}, extractedRelations: {} };
        this.parseErrorFiles.clear();
        this.indexedContents.clear();
        await this.cache.clear();
    }

    /** 반복 생성 시 파서의 WASM 메모리를 해제한다. */
    public dispose(): void {
        this.parser.dispose();
    }
}
