---
name: lightweight-graph-mcp
description: Lightweight Graph MCP로 코드 그래프를 생성하고 심볼, 호출·상속·임포트 관계, 핵심 노드, 커뮤니티, 최단 경로, 변경 영향도를 분석한다. 코드 구조 파악, 호출자·피호출자 추적, 아키텍처 요약, 코드 그래프 생성 요청 시 사용한다.
---

# Lightweight Graph MCP (`lightweight-graph-mcp`)

Tree-sitter WASM 기반으로 13개 언어(JS, TS, TSX, Python, Java, Go, Rust, C, C++, C#, Obj-C, Obj-C++, CUDA)의 AST에서 심볼과 호출·임포트·상속·구현 관계를 추출하고, `<project>/.tools/.graphify/` 아래에 `graph-cache.json`, `graph.json`, `GRAPH_REPORT.md`, `graph.html`을 생성·조회하는 경량 코드 그래프 도구다.

## MCP 도구 사용

전역 MCP 서버 `lightweight-graph-mcp`가 등록되어 있으면 모든 도구에 `project_path` 인수로 분석 대상 프로젝트의 절대 경로를 전달할 수 있다.

현재 세션에 MCP 도구가 노출되어 있는지 먼저 확인한다. 도구가 없으면 연결 상태 확인이 필요하다고 알리고, 기존 `.tools/.graphify/GRAPH_REPORT.md`가 있으면 참고한다.

- `get_index_status({ project_path })`: 대상 프로젝트의 그래프 생성 여부(`Ready` / `NotBuilt`) 및 산출물 경로 확인
- `build_index({ project_path })`: 대상 프로젝트의 코드 그래프 생성·갱신 (`.tools/.graphify/graph.json`, `GRAPH_REPORT.md`, `graph.html` 생성)
- `get_project_overview({ project_path })`: 파일·심볼·관계·커뮤니티 수 및 상위 핵심 심볼 요약
- `query_graph({ question, mode: "bfs" | "dfs", depth, max_nodes, project_path })`: 키워드·질문과 연관된 시드 노드로부터 주변 서브그래프 문맥 탐색
- `shortest_path({ source, target, max_hops, project_path })`: 두 심볼 또는 파일 사이의 최단 연결 경로(BFS) 탐색
- `get_god_nodes({ top_n, project_path })`: 가장 연결이 집중된 핵심 추상화 심볼(God Nodes) 조회
- `get_communities({ community_id, project_path })`: 모듈 커뮤니티 목록, 응집도(Cohesion), 소속 심볼 조회
- `search_symbols({ query, max_nodes, project_path })`: 이름·패턴으로 심볼 검색
- `get_symbol_info({ symbol, project_path })`: 심볼 정의 위치(`filePath`, `range`) 및 종류 조회
- `get_callers({ target, project_path })` / `get_callees({ target, project_path })`: 상위 호출자 / 하위 피호출자 추적
- `get_impact({ target, max_depth, project_path })`: 심볼 수정 시 직·간접적으로 영향받는 상위 심볼 추적
- `get_dependencies({ target, project_path })`: 특정 심볼·파일의 외부 호출·임포트·상속 관계 조회

## 권장 워크플로

1. 대상 프로젝트에 대해 먼저 `get_index_status`를 확인하고, `NotBuilt`이거나 최근 코드 변경이 있으면 `build_index`를 실행한다.
2. 전체 아키텍처 파악 시 `get_project_overview`, `get_god_nodes`, `get_communities` 또는 `.tools/.graphify/GRAPH_REPORT.md`를 먼저 읽는다.
3. 특정 기능 흐름이나 수정 범위를 분석할 때는 `query_graph`, `shortest_path`, `get_impact`로 연관 심볼과 파일 위치를 좁힌 뒤 해당 파일만 읽는다.
