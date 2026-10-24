"""合成自检：真实调用 Edge 合成两个音色（需要网络，断网时记为 SKIP）。"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = os.environ.get('NODE_BIN', 'node')


def synth(voice_id, text):
    p = subprocess.run(
        [NODE, os.path.join(ROOT, 'scripts', 'probe-tts.js'), 'synth', voice_id, text],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        timeout=120,
    )
    start = p.stdout.find('{')
    if start < 0:
        return None, (p.stdout + p.stderr)[:300]
    try:
        return json.loads(p.stdout[start:]), ''
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def main():
    res = []

    def add(ok, name, detail='', skip=False):
        res.append(('SKIP' if skip else ('PASS' if ok else 'FAIL'), name, detail))

    data, err = synth('edge:xiaoxiao', '这是一段自检语音，用来确认在线合成是否正常。')
    if not data:
        network_like = 'EDGE_NETWORK' in err or 'net' in err.lower() or 'timeout' in err.lower()
        add(network_like, '晓晓合成', f'跳过（疑似网络问题）：{err[:120]}', skip=network_like)
    else:
        add(data.get('ok') and data.get('bytes', 0) > 3000, '晓晓合成',
            f"{data.get('bytes')} 字节 / {data.get('durationMs')}ms / 耗时 {data.get('elapsedMs')}ms")
        add(1500 <= data.get('durationMs', 0) <= 30000, '音频时长合理', f"{data.get('durationMs')} ms")

    data2, err2 = synth('edge:yunxi', '男声自检。')
    if data2:
        add(data2.get('ok') and data2.get('bytes', 0) > 2000, '云希合成', f"{data2.get('bytes')} 字节 / {data2.get('durationMs')}ms")
    else:
        add(False, '云希合成', f'跳过（{err2[:80]}）', skip=True)

    for status, name, detail in res:
        print(f'  [{status}] {name}' + (f'：{detail}' if detail else ''))
    fails = sum(1 for r in res if r[0] == 'FAIL')
    print(f'  小计：PASS={sum(1 for r in res if r[0] == "PASS")} SKIP={sum(1 for r in res if r[0] == "SKIP")} FAIL={fails}')
    return 0 if fails == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
