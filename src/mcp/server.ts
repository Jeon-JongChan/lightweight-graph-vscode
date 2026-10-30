import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GraphTools } from "./tools";
import * as fs from 'fs';
import * as path from 'path';
import { GraphCache } from '../storage/cache';
import { GraphData } from '../common/types';
import { buildProjectIndex, ProjectWatcher } from '../core/build';
import languages from '../common/languages.json';

/** 다중 프로젝트 경로(project_path)와 전역·작업영역 실행을 모두 지원하는 그래프 MCP 서버이다. */
export class GraphMcpServer {
    private server: McpServer;
    private activeRoot: string;
    private indexBuilt = false;
    private graphData: GraphData = { version: '1.0', symbols: {}, relations: {} };
    private loadedCacheMeta: { root: string; filePath: string; mtimeMs: number; size: number } | null = null;
    private tools: GraphTools;

    /** 기본 작업 영역 루트를 설정하고 MCP 도구를 등록한다. */
    constructor(private readonly workspaceRoot: string) {
        this.activeRoot = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : path.resolve(workspaceRoot);
        this.server = new McpServer({
            name: "Lightweight Graph MCP",
            version: "1.0.1"
        });
        this.tools = new GraphTools(() => this.graphData, () => this.activeRoot);
        this.registerTools();
    }

    /** 요청별 project_path 또는 기본 작업 영역 루트를 검증하여 실제 경로로 반환한다. */
    private resolveTargetRoot(projectPath?: string): string {
        const target = projectPath ? path.resolve(projectPath) : this.workspaceRoot;
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
            throw new Error(`유효한 프로젝트 디렉터리 경로가 아닙니다: ${target}`);
        }
        return fs.realpathSync(target);
    }

    /** 대상 프로젝트의 캐시가 변경되었을 때만 다시 읽어 메모리에 반영한다. */
    public async reloadIndexIfNeeded(projectPath?: string): Promise<{ root: string; cache: GraphCache }> {
        const root = this.resolveTargetRoot(projectPath);
        const cache = new GraphCache(root);
        const primaryPath = cache.getCachePath();
        const legacyPath = path.join(root, '.mcp', 'graph-cache.json');
        const activeFile = fs.existsSync(primaryPath) ? primaryPath : (fs.existsSync(legacyPath) ? legacyPath : '');

        if (activeFile) {
            const stat = fs.statSync(activeFile);
            if (
                this.loadedCacheMeta &&
                this.loadedCacheMeta.root === root &&
                this.loadedCacheMeta.filePath === activeFile &&
                this.loadedCacheMeta.mtimeMs === stat.mtimeMs &&
                this.loadedCacheMeta.size === stat.size
            ) {
                this.activeRoot = root;
                return { root, cache };
            }
            const loaded = await cache.load();
            this.activeRoot = root;
            this.indexBuilt = loaded !== null;
            this.graphData = loaded ?? { version: '1.0', symbols: {}, relations: {} };
            this.loadedCacheMeta = loaded ? { root, filePath: activeFile, mtimeMs: stat.mtimeMs, size: stat.size } : null;
            return { root, cache };
        }

        this.activeRoot = root;
        this.indexBuilt = false;
        this.graphData = { version: '1.0', symbols: {}, relations: {} };
        this.loadedCacheMeta = null;
        return { root, cache };
    }

    /** 그래프 생성 및 심볼·호출·서브그래프·커뮤니티 조회 도구 13개를 등록한다. */
    private registerTools() {
        const projectPathParam = z.string().optional().describe("분석할 프로젝트 루트 절대 경로 (생략 시 서버 기본 작업 영역 사용)");

        this.server.tool('build_index',
            '프로젝트의 코드 그래프(graph-cache.json, graph.json, GRAPH_REPORT.md, graph.html)를 생성·갱신합니다. 소스는 변경하지 않으며 .tools/.graphify에 저장합니다.',
            { project_path: projectPathParam },
            async ({ project_path }) => {
                try {
                    const root = this.resolveTargetRoot(project_path);
                    const result = await buildProjectIndex(root, path.resolve(__dirname, '../..'));
                    await this.reloadIndexIfNeeded(root);
                    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
                } catch (error) {
                    return { isError: true, content: [{ type: 'text' as const, text: `그래프 생성 실패: ${error}` }] };
                }
            });

        this.server.tool("search_symbols",
            "이름이나 식별자 패턴으로 함수·클래스·인터페이스 심볼을 검색합니다.",
            {
                query: z.string().describe("검색할 심볼 이름 또는 부분 문자열"),
                max_nodes: z.number().int().min(1).optional().describe("최대 반환 개수 (기본 30)"),
                project_path: projectPathParam
            },
            async ({ query, max_nodes, project_path }) => {
                await this.reloadIndexIfNeeded(project_path);
                const results = this.tools.searchSymbols(query, max_nodes ?? 30);
                return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
            }
        );

        this.server.tool("get_symbol_info",
            "특정 심볼의 파일 위치, 범위, 종류 등 상세 정보를 조회합니다.",
            {
                symbol: z.string().describe("심볼 이름 또는 전체 식별자"),
                project_path: projectPathParam
            },
            async ({ symbol, project_path }) => {
                await this.reloadIndexIfNeeded(project_path);
                const info = this.tools.getSymbolInfo(symbol);
                return { content: [{ type: "text", text: info ? JSON.stringify(info, null, 2) : "Symbol not found" }] };
            }
        );

        this.server.tool("get_dependencies",
            "특정 심볼이나 모듈이 호출·임포트·상속하는 의존성 관계를 조회합니다.",
            {
                target: z.string().describe("대상 심볼 또는 모듈 이름"),
                project_path: projectPathParam
            },
            async ({ target, project_path }) => {
                await this.reloadIndexIfNeeded(project_path);
                const deps = this.tools.getDependencies(target);
                return { content: [{ type: "text", text: JSON.stringify(deps, null, 2) }] };
            }
        );

        this.server.tool("get_callers",
            "특정 함수를 호출하는 모든 상위 호출자(caller) 관계를 찾습니다.",
            {
                target: z.string().describe("대상 함수 또는 메서드 이름"),
                project_path: projectPathParam
            },
            async ({ target, project_path }) => {
                await this.reloadIndexIfNeeded(project_path);
                const callers = this.tools.getCallers(target);
                return { content: [{ type: "text", text: JSON.stringify(callers, null, 2) }] };
            }
        );

        this.server.tool("get_callees",
            "특정 함수가 내부에서 호출하는 하위 피호출자(callee) 관계를 찾습니다.",
            {
                target: z.string().describe("대상 함수 또는 메서드 이름"),
                project_path: projectPathParam
            },
            async ({ target, project_path }) => {
                await this.reloadIndexIfNeeded(project_path);
                const callees = this.tools.getCallees(target);
                return { content: [{ type: "text", text: JSON.stringify(callees, null, 2) }] };
            }
        );

        this.server.tool("get_impact",
            "특정 심볼을 수정할 때 직·간접적으로 영향받는 상위 호출·상속 심볼 범위를 분석합니다.",
            {
                target: z.string().describe("대상 심볼 이름"),
                max_depth: z.number().int().min(1).optional().describe("최대 추적 홉 깊이 (기본 3)"),
                project_path: projectPathParam
            },
            async ({ target, max_depth, project_path }) => {
                await this.reloadIndexIfNeeded(project_path);
                const impact = this.tools.getImpact(target, max_depth ?? 3);
                return { content: [{ type: "text", text: JSON.stringify(impact, null, 2) }] };
            }
        );

        this.server.tool("query_graph",
            "질의어와 관련된 시드 노드에서 BFS 또는 DFS로 주변 서브그래프 문맥을 탐색합니다.",
            {
                question: z.string().describe("검색할 키워드, 심볼 이름 또는 질문"),
                mode: z.enum(["bfs", "dfs"]).optional().describe("탐색 방식: bfs(기본) 또는 dfs"),
                depth: z.number().int().min(1).optional().describe("탐색 깊이 (기본 3)"),
                max_nodes: z.number().int().min(1).optional().describe("최대 반환 노드 수 (기본 30)"),
                project_path: projectPathParam
            },
            async ({ question, mode, depth, max_nodes, project_path }) => {
                await this.reloadIndexIfNeeded(project_path);
                const result = this.tools.queryGraph(question, mode ?? "bfs", depth ?? 3, max_nodes ?? 30);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }
        );

        this.server.tool("shortest_path",
            "두 심볼 또는 파일 사이의 최단 연결 경로(BFS)를 찾습니다.",
            {
                source: z.string().describe("출발 심볼 또는 파일 이름"),
                target: z.string().describe("도착 심볼 또는 파일 이름"),
                max_hops: z.number().int().min(1).optional().describe("최대 허용 홉 수 (기본 8)"),
                project_path: projectPathParam
            },
            async ({ source, target, max_hops, project_path }) => {
                await this.reloadIndexIfNeeded(project_path);
                const result = this.tools.findShortestPath(source, target, max_hops ?? 8);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }
        );

        this.server.tool("get_god_nodes",
            "프로젝트에서 가장 연결이 집중된 핵심 추상화 심볼(God Nodes) 상위 목록을 조회합니다.",
            {
                top_n: z.number().int().min(1).optional().describe("반환할 상위 심볼 수 (기본 10)"),
                project_path: projectPathParam
            },
            async ({ top_n, project_path }) => {
                await this.reloadIndexIfNeeded(project_path);
                const result = this.tools.getGodNodes(top_n ?? 10);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }
        );

        this.server.tool("get_communities",
            "코드 그래프의 모듈 커뮤니티 목록과 응집도(Cohesion), 또는 특정 커뮤니티 상세 노드를 조회합니다.",
            {
                community_id: z.number().int().min(0).optional().describe("특정 커뮤니티 번호 (생략 시 전체 요약 반환)"),
                project_path: projectPathParam
            },
            async ({ community_id, project_path }) => {
                await this.reloadIndexIfNeeded(project_path);
                const result = this.tools.getCommunities(community_id);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }
        );

        this.server.tool("get_project_overview",
            "프로젝트의 파일·심볼·관계·커뮤니티 통계와 핵심 노드를 요약합니다.",
            { project_path: projectPathParam },
            async ({ project_path }) => {
                await this.reloadIndexIfNeeded(project_path);
                const overview = this.tools.getProjectOverview();
                return { content: [{ type: "text", text: JSON.stringify(overview, null, 2) }] };
            }
        );

        this.server.tool("get_index_status",
            "현재 프로젝트 그래프 색인 상태, 산출물 경로, 지원 언어 목록을 확인합니다.",
            { project_path: projectPathParam },
            async ({ project_path }) => {
                const { root, cache } = await this.reloadIndexIfNeeded(project_path);
                const dir = path.dirname(cache.getCachePath());
                const symbolsCount = Object.keys(this.graphData.symbols).length;
                const status = this.indexBuilt ? "Ready" : "NotBuilt";
                return {
                    content: [
                        { type: "text", text: JSON.stringify({
                            status,
                            workspaceRoot: root,
                            symbolsCount,
                            relationsCount: Object.keys(this.graphData.relations).length,
                            supportedLanguages: Object.keys(languages),
                            supportedExtensions: [...new Set(Object.values(languages).flatMap(config => config.extensions))],
                            cachePath: cache.getCachePath(),
                            graphPath: path.join(dir, 'graph.json'),
                            reportPath: path.join(dir, 'GRAPH_REPORT.md'),
                            htmlPath: path.join(dir, 'graph.html'),
                            generationMode: 'manual',
                            buildTool: 'build_index'
                        }, null, 2) }
                    ]
                };
            }
        );
    }

    /** CLI 모드에서 단일 명령을 실행하고 결과를 반환한다. */
    public async executeCliCommand(command: string, args: string[]): Promise<string> {
        switch (command) {
            case 'build': {
                const root = this.resolveTargetRoot(args[0]);
                const result = await buildProjectIndex(root, path.resolve(__dirname, '../..'));
                return JSON.stringify(result, null, 2);
            }
            case 'watch': {
                const root = this.resolveTargetRoot(args[0]);
                const debounceMs = Math.max(200, Number(args[1]) * 1000 || 2500);
                const watcher = new ProjectWatcher(root, path.resolve(__dirname, '../..'), {
                    debounceMs,
                    onRebuildStart: files => console.error(`[graph-mcp watch] 변경 감지 (${files.length}개 파일) -> 그래프 갱신 시작...`),
                    onRebuildDone: res => console.error(`[graph-mcp watch] 갱신 완료: 파일 ${res.filesIndexed}개, 심볼 ${res.symbolsCount}개, 관계 ${res.relationsCount}개`),
                    onRebuildError: err => console.error(`[graph-mcp watch] 갱신 실패: ${err}`)
                });
                watcher.start();
                console.error(`[graph-mcp watch] 감시 중: ${root} (디바운스 ${debounceMs / 1000}초, 종료하려면 Ctrl+C)`);
                await new Promise<void>(resolve => {
                    process.once('SIGINT', () => { watcher.stop(); resolve(); });
                    process.once('SIGTERM', () => { watcher.stop(); resolve(); });
                });
                return JSON.stringify({ status: 'Stopped', workspaceRoot: root }, null, 2);
            }
            case 'status': {
                const { root, cache } = await this.reloadIndexIfNeeded(args[0]);
                const dir = path.dirname(cache.getCachePath());
                return JSON.stringify({
                    status: this.indexBuilt ? 'Ready' : 'NotBuilt',
                    workspaceRoot: root,
                    symbolsCount: Object.keys(this.graphData.symbols).length,
                    relationsCount: Object.keys(this.graphData.relations).length,
                    supportedLanguages: Object.keys(languages),
                    supportedExtensions: [...new Set(Object.values(languages).flatMap(config => config.extensions))],
                    cachePath: cache.getCachePath(),
                    graphPath: path.join(dir, 'graph.json'),
                    reportPath: path.join(dir, 'GRAPH_REPORT.md'),
                    htmlPath: path.join(dir, 'graph.html')
                }, null, 2);
            }
            case 'overview': {
                await this.reloadIndexIfNeeded(args[0]);
                return JSON.stringify(this.tools.getProjectOverview(), null, 2);
            }
            case 'search': {
                await this.reloadIndexIfNeeded(args[1]);
                return JSON.stringify(this.tools.searchSymbols(args[0] || ''), null, 2);
            }
            case 'symbol': {
                await this.reloadIndexIfNeeded(args[1]);
                return JSON.stringify(this.tools.getSymbolInfo(args[0] || ''), null, 2);
            }
            case 'dependencies': {
                await this.reloadIndexIfNeeded(args[1]);
                return JSON.stringify(this.tools.getDependencies(args[0] || ''), null, 2);
            }
            case 'callers': {
                await this.reloadIndexIfNeeded(args[1]);
                return JSON.stringify(this.tools.getCallers(args[0] || ''), null, 2);
            }
            case 'callees': {
                await this.reloadIndexIfNeeded(args[1]);
                return JSON.stringify(this.tools.getCallees(args[0] || ''), null, 2);
            }
            case 'impact': {
                await this.reloadIndexIfNeeded(args[1]);
                return JSON.stringify(this.tools.getImpact(args[0] || ''), null, 2);
            }
            case 'query': {
                await this.reloadIndexIfNeeded(args[1]);
                return JSON.stringify(this.tools.queryGraph(args[0] || ''), null, 2);
            }
            case 'path': {
                await this.reloadIndexIfNeeded(args[2]);
                return JSON.stringify(this.tools.findShortestPath(args[0] || '', args[1] || ''), null, 2);
            }
            case 'god-nodes': {
                await this.reloadIndexIfNeeded(args[0]);
                return JSON.stringify(this.tools.getGodNodes(10), null, 2);
            }
            case 'communities': {
                await this.reloadIndexIfNeeded(args[0]);
                return JSON.stringify(this.tools.getCommunities(), null, 2);
            }
            case 'report': {
                const { cache } = await this.reloadIndexIfNeeded(args[0]);
                const reportPath = path.join(path.dirname(cache.getCachePath()), 'GRAPH_REPORT.md');
                if (!fs.existsSync(reportPath)) {
                    throw new Error(`리포트 파일이 없습니다. 먼저 build 명령을 실행하세요: ${reportPath}`);
                }
                return fs.readFileSync(reportPath, 'utf8');
            }
            default:
                return [
                    '사용법: graph-mcp.cmd <명령> [인수...]',
                    '  build [project_path]                 프로젝트 코드 그래프 생성 (.tools/.graphify)',
                    '  status [project_path]                색인 상태 및 산출물 경로 확인',
                    '  overview [project_path]              프로젝트 전체 통계 및 핵심 노드 요약',
                    '  query <question> [project_path]      키워드 기반 BFS 서브그래프 문맥 탐색',
                    '  path <source> <target> [project_path] 두 심볼·파일 간 최단 경로 탐색',
                    '  god-nodes [project_path]             가장 연결이 집중된 핵심 심볼 조회',
                    '  communities [project_path]           탐지된 커뮤니티 및 응집도 조회',
                    '  search <query> [project_path]        심볼 이름 검색',
                    '  symbol <name> [project_path]         단일 심볼 상세 정보 조회',
                    '  callers <name> [project_path]        상위 호출자(caller) 조회',
                    '  callees <name> [project_path]        하위 피호출자(callee) 조회',
                    '  impact <name> [project_path]         변경 시 영향받는 상위 심볼 추적',
                    '  report [project_path]                생성된 GRAPH_REPORT.md 출력'
                ].join('\n');
        }
    }

    /** stdout을 MCP 전용으로 유지하며 stdio 전송을 시작한다. */
    public async start() {
        await this.reloadIndexIfNeeded();
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Lightweight Graph MCP server started");
    }
}

const CLI_COMMANDS = new Set([
    'build', 'watch', 'status', 'overview', 'search', 'symbol', 'dependencies',
    'callers', 'callees', 'impact', 'query', 'path', 'god-nodes', 'communities',
    'report', 'help', '--help', '-h'
]);

if (require.main === module) {
    const firstArg = process.argv[2];
    if (firstArg && CLI_COMMANDS.has(firstArg)) {
        const server = new GraphMcpServer(process.cwd());
        server.executeCliCommand(firstArg, process.argv.slice(3))
            .then(output => {
                process.stdout.write(output + '\n');
            })
            .catch(err => {
                console.error(`Graph MCP CLI 오류: ${err.message || err}`);
                process.exit(1);
            });
    } else {
        const workspaceRoot = (firstArg === 'serve' ? process.argv[3] : firstArg) || process.cwd();
        const server = new GraphMcpServer(workspaceRoot);
        server.start().catch(err => {
            console.error("Failed to start MCP server:", err);
            process.exit(1);
        });
    }
}
