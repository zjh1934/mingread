"""音色自检：应只有晓晓/云希两个在线音色。"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = os.environ.get('NODE_BIN', 'node')


def main():
    res = []

    def add(ok, name, detail=''):
        res.append(('PASS' if ok else 'FAIL', name, detail))

    p = subprocess.run(
        [NODE, os.path.join(ROOT, 'scripts', 'probe-tts.js'), 'list'],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    start = p.stdout.find('{')
    data = {}
    try:
        data = json.loads(p.stdout[start:]) if start >= 0 else {}
    except Exception as e:  # noqa: BLE001
        add(False, '音色列表解析', str(e))

    voices = data.get('voices', [])
    add(len(voices) == 2, '音色数量=2', f'{len(voices)} 个')
    ids = [v.get('id') for v in voices]
    add('edge:xiaoxiao' in ids, '含晓晓', 'edge:xiaoxiao')
    add('edge:yunxi' in ids, '含云希', 'edge:yunxi')
    add(all(v.get('source') == 'online' for v in voices), '全部标记在线', 'source=online')
    add(all(v.get('engine') == 'edge' for v in voices), '全部走 Edge 引擎', 'engine=edge')

    for status, name, detail in res:
        print(f'  [{status}] {name}' + (f'：{detail}' if detail else ''))
    fails = sum(1 for r in res if r[0] == 'FAIL')
    print(f'  小计：PASS={len(res) - fails} FAIL={fails}')
    return 0 if fails == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
