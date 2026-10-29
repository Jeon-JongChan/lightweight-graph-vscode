"""생성한 VSIX의 문법·런타임·격리 실행 구조를 검증하고 안전하게 펼친다."""

import json
from pathlib import Path
import sys
import tempfile
import zipfile


def main():
    """소스·node_modules 없이 실행할 확장과 모든 등록 문법을 확인한다."""
    project = Path(__file__).resolve().parent.parent
    package = project / (sys.argv[1] if len(sys.argv) > 1 else 'lightweight-graph-mcp-1.2.0.vsix')
    languages = json.loads((project / 'src/common/languages.json').read_text(encoding='utf-8'))
    target = Path(tempfile.mkdtemp(prefix='package-languages-', dir=project / '.test')).resolve()
    with zipfile.ZipFile(package) as archive:
        names = set(archive.namelist())
        expected = {f'extension/dist/wasm/tree-sitter-{row["grammar"]}.wasm' for row in languages.values() if row['grammar']}
        assert expected <= names, f'누락된 문법: {expected - names}'
        assert len([name for name in names if name.startswith('extension/dist/wasm/') and name.endswith('.wasm')]) == len(expected)
        assert all(not name.startswith(('extension/node_modules/', 'extension/.test/', 'extension/.docs/', 'extension/src/', 'extension/dist/core/')) for name in names)
        for entry in ['extension', 'mcp']:
            assert f'extension/dist/{entry}/tree-sitter.wasm' in names
        for name in names:
            assert (target / name).resolve().is_relative_to(target), f'패키지 경로 이탈: {name}'
        archive.extractall(target)
    output = target / '.tools' / '.graphify'
    output.mkdir(parents=True)
    result = {'package': str(package), 'bytes': package.stat().st_size, 'grammars': len(expected),
              'extension': str(target / 'extension'), 'server': str(target / 'extension/dist/mcp/server.js')}
    (output / 'package-validation.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
