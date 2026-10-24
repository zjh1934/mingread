"""环境自检：Node / Python / 依赖 / 图标 / 构建产物。"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
results = []


def add(ok, name, detail=''):
    results.append(('PASS' if ok else 'FAIL', name, detail))


def main():
    try:
        out = subprocess.check_output(['node', '--version'], text=True).strip()
        add(int(out.lstrip('v').split('.')[0]) >= 18, 'Node 版本', f'{out}（要求 >= 18）')
    except Exception as e:  # noqa: BLE001
        add(False, 'Node 版本', str(e))

    add(sys.version_info >= (3, 8), 'Python 版本', sys.version.split()[0])

    for name in ['electron', 'node-edge-tts']:
        p = os.path.join(ROOT, 'node_modules', *name.split('/'), 'package.json')
        ver = ''
        if os.path.exists(p):
            try:
                ver = json.load(open(p, encoding='utf-8')).get('version', '')
            except Exception:  # noqa: BLE001
                pass
        add(os.path.exists(p), f'依赖 {name}', ver)

    # 已弃用的原生语音模块不应再出现在依赖里
    pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))
    deps = pkg.get('dependencies', {})
    add('sherpa-onnx-node' not in deps, '已移除内置引擎依赖', 'sherpa-onnx-node 未声明')
    add('@echogarden/windows-media-tts' not in deps, '已移除微软语音模块依赖', 'windows-media-tts 未声明')

    add(os.path.exists(os.path.join(ROOT, 'resources', 'icon.png')), '应用图标', 'resources/icon.png')
    add(not os.path.isdir(os.path.join(ROOT, 'resources', 'tts')), '不再内置语音模型', 'resources/tts 不存在')
    add(not os.path.isdir(os.path.join(ROOT, 'resources', 'voices')), '不再内置微软语音包', 'resources/voices 不存在')

    dist = os.path.join(ROOT, 'dist', 'renderer', 'index.html')
    add(os.path.exists(dist), '渲染层构建产物', 'dist/renderer/index.html' if os.path.exists(dist) else '未构建')

    for status, name, detail in results:
        print(f'  [{status}] {name}' + (f'：{detail}' if detail else ''))
    fails = sum(1 for r in results if r[0] == 'FAIL')
    print(f'  小计：PASS={len(results) - fails} FAIL={fails}')
    return 0 if fails == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
