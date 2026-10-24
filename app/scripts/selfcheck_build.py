"""工程结构自检：版本一致性、必备文件、旧方案残留、打包产物体积。"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
res = []


def add(ok, name, detail=''):
    res.append(('PASS' if ok else 'FAIL', name, detail))


def exists(rel):
    return os.path.exists(os.path.join(ROOT, rel))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def main():
    pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))
    add(pkg.get('version') == '2.3.0', 'package.json 版本', pkg.get('version'))

    consts = read('src/shared/constants.js')
    m = re.search(r"APP_VERSION:\s*'([^']+)'", consts)
    add(bool(m) and m.group(1) == pkg.get('version'), '版本一致', f"constants={m.group(1) if m else '?'}")

    # 引擎链（v2.3.1 起）：本地 NVSA（SAPI）优先 → espeak（仅沙箱验证）→ Edge 在线兜底
    backends = os.listdir(os.path.join(ROOT, 'src/main/backends'))
    for need in ['sapiBackend.js', 'edgeTtsBackend.js', 'espeakBackend.js', 'index.js']:
        add(need in backends, f'引擎后端在位 {need}', '')
    add('仅两个音色' and consts.count("key: 'xiaoxiao'") == 1 and consts.count("key: 'yunxi'") == 1, '音色定义=晓晓/云希', '2 个')

    for rel in [
        'README.md',
        'LICENSE',
        'THIRD-PARTY-NOTICES.md',
        'electron-builder.yml',
        'vite.config.js',
        'resources/icon.ico',
        'resources/icon.png',
        'src/main/selectionReader.js',
        'src/main/hotkeyTray.js',
        'src/main/ttsBridge.js',
        'src/main/backends/edgeTtsBackend.js',
        'src/renderer/components/VoicePicker.jsx',
    ]:
        add(exists(rel), f'文件存在 {rel}')

    # 废弃文件必须已删除（sapiBackend.js 已于 v2.3.1 随 NVSA 重开恢复存在，不在此列）
    for rel in ['src/main/backends/builtinNeuralBackend.js', 'src/main/msVoiceProvisioner.js',
                'src/renderer/components/EnginePanel.jsx']:
        add(not exists(rel), f'已删除 {rel}')

    # 源码内不得残留旧引擎引用（NaturalVoiceSAPIAdapter 是 v2.3.1 重开的本地 NVSA 宿主，不再是残留）
    banned = ['sherpa-onnx', 'windows-media-tts', 'msVoiceProvisioner']
    hits = []
    for dirpath, _dirs, files in os.walk(os.path.join(ROOT, 'src')):
        for fn in files:
            p = os.path.join(dirpath, fn)
            try:
                txt = open(p, encoding='utf-8', errors='ignore').read()
            except Exception:  # noqa: BLE001
                continue
            for b in banned:
                if b.lower() in txt.lower():
                    hits.append(f'{os.path.relpath(p, ROOT)} -> {b}')
    add(not hits, '旧引擎代码残留', '未命中' if not hits else '；'.join(hits[:5]))

    # 划词热键（v2.3.1 起默认 Ctrl+Alt+R；F1 仅为可选预设）
    add("DEFAULT_HOTKEY: 'Ctrl+Alt+R'" in consts, '默认热键 Ctrl+Alt+R', 'constants 中已配置')
    add('readSelection' in read('src/main/selectionReader.js'), '划词读取实现', 'selectionReader.js')
    add("globalShortcut.register" in read('src/main/hotkeyTray.js'), '全局热键注册', 'hotkeyTray.js')

    # 复制即读（v2.3.1 起默认开：低视力刚需，带节流与长度上限）
    add('clipboardAuto: true' in read('src/main/settingsStore.js'), '复制即读默认开', 'settingsStore 默认值')

    # 打包产物（交接包只含源码 + win-unpacked，安装包/免安装 zip 在 tdrive 资产，不在此断言）
    dist = os.path.join(ROOT, 'dist')
    if os.path.isdir(dist):
        unpacked = os.path.join(dist, 'win-unpacked', 'resources', 'app.asar')
        add(os.path.exists(unpacked), '打包应用产物', 'dist/win-unpacked' if os.path.exists(unpacked) else '未打包')
        exes = [f for f in os.listdir(dist) if f.endswith('.exe') and '安装包' in f]
        for f in exes:
            size = os.path.getsize(os.path.join(dist, f))
            add(size < 160 * 1024 * 1024, '安装包体积 < 160MB', f'{size / 1048576:.0f} MB')
        if not os.path.isdir(os.path.join(dist, 'win-unpacked', 'resources')):
            add(not os.path.isdir(os.path.join(dist, 'win-unpacked', 'resources', 'tts')), '产物不含内置语音模型', 'resources/tts 缺失（预期）')
    else:
        add(False, '打包产物', '未打包（npm run dist）')

    for status, name, detail in res:
        print(f'  [{status}] {name}' + (f'：{detail}' if detail else ''))
    fails = sum(1 for r in res if r[0] == 'FAIL')
    print(f'  小计：PASS={len(res) - fails} FAIL={fails}')
    return 0 if fails == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
