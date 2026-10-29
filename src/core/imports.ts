import * as fs from 'fs';
import * as path from 'path';
import { GraphData } from '../common/types';
import languages from '../common/languages.json';
import { CodeParser } from './parser';
import { getLanguageAnalyzer } from './analyzers';

/** JSONC 문자열에서 문자열 리터럴을 보존하면서 주석과 끝 쉼표를 제거한다. */
function stripJsonc(raw: string): string {
    const withoutComments = raw.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, match =>
        match.startsWith('"') ? match : ''
    );
    return withoutComments.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, trailing) => trailing || match);
}

/** Graphify extractors/resolution.py에 대응하는 로컬 임포트 해석 어댑터다. */
export class ImportResolver {
    /** 프로젝트와 현재 심볼·관계 스냅샷을 연결한다. */
    constructor(private data: GraphData, private workspaceRoot: string) {}

    /** 상대 extends의 순환을 막고 선언된 설정 디렉터리를 기준으로 별칭을 읽는다. */
    private loadTsConfigAliases(): { baseUrl: string | null; paths: Record<string, string[]> } {
        /** 자식 옵션이 부모 옵션을 대체하되 상대 경로의 원래 기준은 보존한다. */
        function readConfig(configPath: string, seen = new Set<string>()): { baseUrl: string | null; paths: Record<string, string[]>; pathsBase: string } {
            if (seen.has(configPath)) throw new Error('설정 상속이 순환합니다.');
            seen.add(configPath);
            const parsed = JSON.parse(stripJsonc(fs.readFileSync(configPath, 'utf-8')));
            const directory = path.dirname(configPath);
            // shortcut: 패키지 이름 extends는 해석하지 않는다. 패키지 설정 지원 시 Node 모듈 탐색을 추가한다.
            const inherited = typeof parsed.extends === 'string' && parsed.extends.startsWith('.')
                ? readConfig(path.resolve(directory, fs.existsSync(path.resolve(directory, parsed.extends)) ? parsed.extends : `${parsed.extends}.json`), seen)
                : { baseUrl: null, paths: {}, pathsBase: directory };
            const co = parsed?.compilerOptions || {};
            return {
                baseUrl: typeof co.baseUrl === 'string' ? path.resolve(directory, co.baseUrl) : inherited.baseUrl,
                paths: co.paths && typeof co.paths === 'object' ? co.paths : inherited.paths,
                pathsBase: co.paths && typeof co.paths === 'object' ? directory : inherited.pathsBase
            };
        }
        for (const name of ['tsconfig.json', 'jsconfig.json']) {
            const configPath = path.join(this.workspaceRoot, name);
            if (!fs.existsSync(configPath)) continue;
            try {
                const config = readConfig(configPath);
                const baseUrl = config.baseUrl;
                const pathsMap: Record<string, string[]> = {};
                if (config.paths) {
                    const baseDir = baseUrl || config.pathsBase;
                    for (const [alias, targets] of Object.entries(config.paths)) {
                        if (Array.isArray(targets)) {
                            pathsMap[alias] = targets
                                .filter((t): t is string => typeof t === 'string' && t.length > 0)
                                .map(t => path.resolve(baseDir, t.replace(/\/?\*$/, '')));
                        }
                    }
                }
                return { baseUrl, paths: pathsMap };
            } catch {
                // 잘못된 tsconfig는 무시하고 기본 상대 경로 해석만 수행한다.
            }
        }
        return { baseUrl: null, paths: {} };
    }

    /** 상대 임포트·tsconfig 별칭·TS ESM(.js->.ts) 및 모듈 경로를 이미 색인된 파일에 연결한다. */
    public resolve() {
        const knownFiles = new Set<string>(this.data.files || []);
        for (const symId in this.data.symbols) {
            knownFiles.add(this.data.symbols[symId].filePath);
        }

        const exts = Object.values(languages).flatMap(config => config.extensions);
        const tsConfig = this.loadTsConfigAliases();

        for (const id of Object.keys(this.data.relations)) {
            const rel = this.data.relations[id];
            if (!rel || rel.kind !== 'import') continue;

            if (knownFiles.has(rel.targetId)) {
                rel.certainty = 'RESOLVED';
                rel.confidenceScore = 1.0;
                continue;
            }

            let resolvedTargetId: string | null = null;
            const candidates = [rel.targetId];
            const language = CodeParser.getLanguageFromFile(rel.sourceId);
            const analyzer = language ? getLanguageAnalyzer(language) : null;
            const candidateExts = analyzer?.importExtensions || exts;

            // tsconfig.json compilerOptions.paths 및 baseUrl 확장
            for (const [aliasPattern, targetDirs] of analyzer?.family === 'script' ? Object.entries(tsConfig.paths) : []) {
                if (aliasPattern.endsWith('/*')) {
                    const prefix = aliasPattern.slice(0, -1);
                    if (rel.targetId.startsWith(prefix)) {
                        const rest = rel.targetId.slice(prefix.length);
                        for (const td of targetDirs) {
                            candidates.push(path.join(td, rest));
                        }
                    }
                } else if (aliasPattern === rel.targetId) {
                    candidates.push(...targetDirs);
                }
            }
            if (analyzer?.family === 'script' && tsConfig.baseUrl && !path.isAbsolute(rel.targetId)) {
                candidates.push(path.join(tsConfig.baseUrl, rel.targetId));
            }

            candidates.push(...(analyzer?.getModuleCandidates(rel.sourceId, rel.targetId, this.workspaceRoot) || []));

            for (const candidate of candidates) {
                if (knownFiles.has(candidate)) {
                    resolvedTargetId = candidate;
                    break;
                }
                // TypeScript ESM 관례: './foo.js' / './foo.jsx' 임포트를 '.ts' / '.tsx' 소스로 매핑한다.
                if (candidate.endsWith('.js')) {
                    const stem = candidate.slice(0, -3);
                    const tsHit = ['.ts', '.tsx', '.mts', '.cts'].map(e => stem + e).find(p => knownFiles.has(p));
                    if (tsHit) {
                        resolvedTargetId = tsHit;
                        break;
                    }
                } else if (candidate.endsWith('.jsx') && knownFiles.has(candidate.slice(0, -4) + '.tsx')) {
                    resolvedTargetId = candidate.slice(0, -4) + '.tsx';
                    break;
                }
                // Graphify와 같이 파일 확장자 후보를 모두 확인한 뒤 디렉터리 인덱스를 찾는다.
                for (const ext of candidateExts) {
                    if (knownFiles.has(candidate + ext)) {
                        resolvedTargetId = candidate + ext;
                        break;
                    }
                }
                if (resolvedTargetId) break;
                for (const ext of candidateExts) {
                    if (knownFiles.has(path.join(candidate, 'index' + ext))) {
                        resolvedTargetId = path.join(candidate, 'index' + ext);
                        break;
                    }
                    if (knownFiles.has(path.join(candidate, '__init__' + ext))) {
                        resolvedTargetId = path.join(candidate, '__init__' + ext);
                        break;
                    }
                }
                if (resolvedTargetId) break;
            }

            if (resolvedTargetId) {
                rel.targetId = resolvedTargetId;
                rel.certainty = 'RESOLVED';
                rel.confidenceScore = 1.0;

                const oldId = rel.id;
                const position = rel.bindings && rel.range ? `@${rel.range.start.line}:${rel.range.start.character}` : '';
                const newId = `${rel.sourceId}::import::${resolvedTargetId}${position}`;
                if (oldId !== newId) {
                    rel.id = newId;
                    this.data.relations[newId] = rel;
                    delete this.data.relations[oldId];
                }
            } else {
                rel.confidenceScore = 0.9;
            }
        }
    }

}
