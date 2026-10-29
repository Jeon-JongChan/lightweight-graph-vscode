"""설치된 Graphify AST 엔진을 동일 입력에 실행하고 비교용 JSON을 저장한다."""

import importlib.metadata
import json
import sys
from pathlib import Path

from graphify.extract import extract


def main():
    """LLM이나 전역 설정 변경 없이 실제 추출 결과를 남긴다."""
    root = Path(sys.argv[1]).resolve()
    output = root / ".tools" / ".graphify"
    output.mkdir(parents=True, exist_ok=True)
    source = root / "src" if (root / "src").is_dir() else root
    extensions = {".ts", ".tsx", ".js", ".py", ".java", ".go", ".rs", ".c", ".h", ".cpp", ".cs", ".m", ".mm", ".cu"}
    paths = sorted(path for path in source.rglob("*") if path.suffix in extensions)
    result = extract(paths, root=root, cache_root=output, parallel=False)
    result["graph"] = {"graphify_version": importlib.metadata.version("graphifyy"), "stage": "AST extraction"}
    (output / "graph.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Graphify 실제 추출: {len(result['nodes'])}개 노드, {len(result['edges'])}개 관계")


if __name__ == "__main__":
    main()
