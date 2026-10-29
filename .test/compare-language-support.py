"""설치된 Graphify 추출기를 동일 언어 입력에 실행하여 원시 결과를 보존한다."""

import hashlib
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import sys

from graphify.extract import _DISPATCH


def main():
    """각 추출기의 실패도 숨기지 않고 결과와 소스 해시를 기록한다."""
    root = Path(sys.argv[1]).resolve()
    samples = json.loads(Path(__file__).with_name('language-support.json').read_text(encoding='utf-8'))
    results = []
    for sample in samples:
        file = root / sample['language'] / sample['file']
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(sample['code'], encoding='utf-8')
        extractor = _DISPATCH.get(file.suffix.lower())
        try:
            result = extractor(file) if extractor else {'error': '추출기 없음'}
        except Exception as error:
            result = {'error': str(error)}
        source = Path(inspect.getsourcefile(extractor)) if extractor else None
        results.append({'file': sample['file'], 'language': sample['language'], 'result': result,
                        'extractor_sha256': hashlib.sha256(source.read_bytes()).hexdigest() if source else None})
    output = root / '.tools' / '.graphify'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'language-comparison.json').write_text(json.dumps({'version': importlib.metadata.version('graphifyy'), 'samples': results}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Graphify 실제 추출: {len(results)}개 입력, 오류 {sum(bool(row["result"].get("error")) for row in results)}개')


if __name__ == '__main__':
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    main()
