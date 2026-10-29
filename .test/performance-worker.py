"""설치된 Graphify의 AST·교차 파일 해석·내부 캐시와 JSON 저장을 측정한다."""
import time
STARTED = time.perf_counter()
import json
import sys
from pathlib import Path
from graphify.extract import extract


def main():
    """캐시 없는 입력·메모리 재사용·변경·프로세스 재시작을 같은 파일에 실행한다."""
    manifest_path, parallel, mode = sys.argv[1:]
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    root = Path(manifest["root"])
    paths = [root / file for file in manifest["files"]]
    output = root / ".tools" / ".graphify"
    output.mkdir(parents=True, exist_ok=True)
    phases = ["restart"] if mode == "restart" else ["cold", "warm0", "warm1", "warm2", "changed"]
    for phase in phases:
        if phase == "changed":
            with paths[0].open("a", encoding="utf-8", newline="") as stream:
                stream.write(manifest["change"])
        begin = time.perf_counter()
        graph = extract(paths, root=root, cache_root=output, parallel=parallel == "parallel", max_workers=4)
        graph_path = output / "graph.json"
        graph_path.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
        elapsed = (time.perf_counter() - begin) * 1000
        assert graph["nodes"], "빈 그래프는 속도 비교 대상이 아니다."
        if phase in ("changed", "restart"):
            assert any(node.get("label", "").removesuffix("()") == "benchmark_added" for node in graph["nodes"])
        print(json.dumps({"phase": phase, "elapsedMs": elapsed, "readyMs": (time.perf_counter() - STARTED) * 1000,
                          "files": len(paths), "nodes": len(graph["nodes"]), "edges": len(graph["edges"]),
                          "output": str(graph_path)}), flush=True)


if __name__ == "__main__":
    main()
