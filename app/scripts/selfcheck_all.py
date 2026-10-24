"""自检总入口：依次跑 环境 / 工程结构 / 音色 / 合成，汇总 PASS-SKIP-FAIL。

用法：
    python scripts/selfcheck_all.py
    python scripts/selfcheck_all.py --quick   # 跳过真实合成
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY = sys.executable

STEPS = [
    ('selfcheck_env.py', '环境与资源', False),
    ('selfcheck_build.py', '工程结构与产物', False),
    ('selfcheck_voices.py', '语音引擎与音色', False),
    ('selfcheck_tts.py', '真实合成', True),
]


def main():
    quick = '--quick' in sys.argv
    total_pass = total_fail = total_skip = 0
    for script, title, slow in STEPS:
        print(f'\n--- {title} ({script}) ---')
        if quick and slow:
            print('  [SKIP] 快速模式跳过')
            total_skip += 1
            continue
        r = subprocess.run([PY, os.path.join(HERE, script)], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace')
        out = (r.stdout or '') + (r.stderr or '')
        print(out.rstrip())
        total_pass += out.count('[PASS]')
        total_fail += out.count('[FAIL]')
        total_skip += out.count('[SKIP]')

    print('\n' + '=' * 56)
    print(f'合计：PASS={total_pass}  SKIP={total_skip}  FAIL={total_fail}')
    print('结论：' + ('PASS（无失败项）' if total_fail == 0 else 'FAIL（存在失败项，见上）'))
    return 0 if total_fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
