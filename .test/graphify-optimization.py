"""설치된 Graphify의 후보 선택 결과와 동일 규모 해석 시간을 측정한다."""
import json
import hashlib
import importlib.metadata
import inspect
import statistics
import sys
import time
from pathlib import Path

from graphify.paths import disambiguate_ambiguous_candidates
from graphify.symbol_resolution import resolve_cross_file_raw_calls
from graphify.extractors.resolution import _resolve_python_module_path


def main():
    """같은 정답 관계 2500개를 생성하는 Graphify 규칙을 직접 실행한다."""
    source = Path(sys.argv[1])
    cases = json.loads(source.read_text(encoding="utf-8"))
    choices = [disambiguate_ambiguous_candidates(list(case["files"]), case["files"], case["caller"]) for case in cases]
    root = source.parent
    caller = root / "pkg/sub/main.py"
    python_targets = []
    for name, level in [("helpers", 2), ("helpers", 1), ("", 2), ("missing", 2)]:
        target = _resolve_python_module_path(name, caller, root, level)
        python_targets.append(target.relative_to(root).as_posix() if target else None)
    nodes = [{"id": f"fn{n}", "label": f"fn{n}()", "file_type": "code", "source_file": f"file{n}.ts"} for n in range(2500)]
    fragments = [{"raw_calls": [{"caller_nid": f"fn{n}", "callee": f"fn{(n + 1) % 2500}", "source_file": f"file{n}.ts"}]} for n in range(2500)]
    timings = []
    for run in range(4):
        started = time.perf_counter()
        edges = resolve_cross_file_raw_calls(fragments, nodes, [])
        elapsed = (time.perf_counter() - started) * 1000
        assert len(edges) == 2500
        if run:
            timings.append(elapsed)
    sources = {}
    for function in (disambiguate_ambiguous_candidates, resolve_cross_file_raw_calls):
        module_file = Path(inspect.getfile(function))
        sources[module_file.name] = hashlib.sha256(module_file.read_bytes()).hexdigest()
    result = {"graphifyVersion": importlib.metadata.version("graphifyy"), "sources": sources,
              "confidenceScores": sorted({edge["confidence_score"] for edge in edges}),
              "choices": choices, "pythonImportTargets": python_targets,
              "medianMs": statistics.median(timings), "samples": timings}
    source.with_name("upstream-result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
