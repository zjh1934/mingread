// 鼠标悬停朗读：指针在文字上停住不动 → 自动读出来（对齐 macOS 的「悬停即读」交互）。
//
// 为什么用「轮询指针位置」而不是低层鼠标钩子：
//   · 钩子（WH_MOUSE_LL）要吃掉/旁路系统输入，风险高；而悬停只需要知道「多久没动」，
//     每 120ms 查一次 screen.getCursorScreenPoint() 就够（单次 <1ms），不碰输入链；
//   · 轮询还天然获得「此刻指针在哪」，不必自己维护坐标。
//   代价是触发时刻最多晚一个轮询周期（120ms），对 650ms 的悬停阈值来说可忽略。
//
// 取词走截图 + 系统 OCR（见 ocrHost.js 顶部注释：UIA/MSAA 在 Chromium 上取不到正文）。
//
// 防误触发（这是体验成败的关键）：
//   1. 必须静止 ≥ hoverDelay（默认 650ms）——滑过时不停留就不会响；
//   2. 同一位置只读一次：指针移动 < 24px（物理像素）视为同一位置，不重复；
//   3. 两次朗读至少间隔 hoverCooldown（默认 1200ms）；
//   4. 正在朗读时跳过（不打断用户主动发起的朗读）；
//   5. 取不到文字时**静默**——悬停是高频动作，没内容就提示会变成噪音。
'use strict';

const { screen } = require('electron');

const DEFAULTS = {
  hoverDelayMs: 650, // 停多久触发
  pollMs: 120, // 轮询周期
  moveTolerancePx: 4, // 小于该位移视为「没动」（物理像素，抗手抖）
  samePosPx: 24, // 触发后需移动超过该距离才允许再次触发
  cooldownMs: 1200, // 两次朗读最小间隔
  regionW: 900, // 截图区域（物理像素）—— 实测这个大小刚好覆盖一段正文
  regionH: 360,
  maxChars: 160, // 单次朗读上限，避免整段太长
  maxLines: 3, // 最多合并几行
};

/** 中文里的「字 与 字」之间会被 OCR 插入空格（它是按 word 切分的），这里合回去 */
function tidyText(raw) {
  let t = String(raw || '').replace(/\u00a0/g, ' ');
  // 汉字 / 中文标点 之间的空格去掉（英文单词之间的空格保留）
  const cjk = '\\u4e00-\\u9fa5\\u3000-\\u303f\\uff00-\\uffef';
  const re = new RegExp(`([${cjk}])\\s+(?=[${cjk}])`, 'g');
  for (let i = 0; i < 4; i += 1) t = t.replace(re, '$1'); // 连续空格可能要多轮才清干净
  return t.replace(/\s{2,}/g, ' ').trim();
}

class HoverReader {
  /**
   * @param {object} opts
   * @param {object} opts.ocr  OcrHost 实例
   * @param {(text: string, meta: object) => void} opts.onText 命中文本时回调（上层负责朗读）
   * @param {() => boolean} [opts.isBusy] 正在朗读时返回 true（跳过本次悬停）
   * @param {(msg: string) => void} [opts.onIssue] 故障播报（仅用于「取词完全不可用」）
   * @param {(px: number, py: number) => boolean} [opts.isSelfPoint] 指针是否在本应用窗口上
   *        （在本窗口上不朗读——读「扫码加我微信」这种界面文字没有意义，还吓人）
   */
  constructor(opts) {
    const o = opts || {};
    this._ocr = o.ocr;
    this._onText = o.onText || (() => {});
    this._isBusy = o.isBusy || (() => false);
    this._onIssue = o.onIssue || (() => {});
    this._isSelfPoint = o.isSelfPoint || (() => false);
    this._cfg = { ...DEFAULTS, ...(o.config || {}) };

    this._timer = null;
    this._lastPos = null; // 上一次采样的指针位置（物理像素）
    this._stillSince = 0; // 从这个时刻起指针没动过
    this._firedAt = 0; // 本次停顿是否已触发过
    this._firedPos = null; // 触发时的位置
    this._lastReadAt = 0;
    this._busyScanning = false;
    this._running = false;
    this._stats = { ticks: 0, hits: 0, misses: 0, errors: 0, lastMs: 0 };
    this._issueReported = false;
  }

  get stats() {
    return { ...this._stats };
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => this._tick(), this._cfg.pollMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._lastPos = null;
    this._firedPos = null;
  }

  dispose() {
    this.stop();
  }

  /** 指针的物理像素坐标（Electron 给的是 DIP，必须换算，否则 125% 缩放的机器会取错位置） */
  _cursorPhysical() {
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    const sf = (d && d.scaleFactor) || 1;
    return { x: Math.round(p.x * sf), y: Math.round(p.y * sf), sf, display: d };
  }

  _tick() {
    if (!this._running || this._busyScanning) return;
    this._stats.ticks += 1;
    const now = Date.now();
    const pos = this._cursorPhysical();

    if (!this._lastPos) {
      this._lastPos = pos;
      this._stillSince = now;
      return;
    }

    const moved =
      Math.abs(pos.x - this._lastPos.x) > this._cfg.moveTolerancePx ||
      Math.abs(pos.y - this._lastPos.y) > this._cfg.moveTolerancePx;

    if (moved) {
      this._lastPos = pos;
      this._stillSince = now;
      // 离开原位置足够远，才允许在同一停顿里再次触发
      if (this._firedPos) {
        const far =
          Math.abs(pos.x - this._firedPos.x) > this._cfg.samePosPx ||
          Math.abs(pos.y - this._firedPos.y) > this._cfg.samePosPx;
        if (far) this._firedPos = null;
      }
      return;
    }

    // 指针停在本应用窗口上：不朗读自己的界面文字
    if (this._isSelfPoint(pos.x, pos.y)) return;

    // 没动：判断是否够久、是否已触发过、冷却是否结束
    if (now - this._stillSince < this._cfg.hoverDelayMs) return;
    if (this._firedPos) return;
    if (now - this._lastReadAt < this._cfg.cooldownMs) return;
    if (this._isBusy()) return;

    this._firedPos = pos;
    this._lastReadAt = now;
    this._scan(pos);
  }

  async _scan(pos) {
    this._busyScanning = true;
    const t0 = Date.now();
    try {
      const { regionW, regionH } = this._cfg;
      const x = Math.max(0, pos.x - Math.round(regionW / 2));
      const y = Math.max(0, pos.y - Math.round(regionH / 2));
      const r = await this._ocr.recognize({ x, y, w: regionW, h: regionH });
      this._stats.lastMs = Date.now() - t0;

      // 指针在截图区域里的相对 Y
      const relY = pos.y - y;
      const lines = (r.lines || []).filter((l) => l && l.t && String(l.t).trim());
      if (!lines.length) {
        this._stats.misses += 1;
        return;
      }

      // 找指针落在哪一行：优先命中区间，否则取最近的一行（容差 24px）
      let idx = lines.findIndex((l) => relY >= l.y && relY <= l.y + (l.h || 0));
      if (idx < 0) {
        let bestDist = Infinity;
        lines.forEach((l, i) => {
          const mid = l.y + (l.h || 0) / 2;
          const d = Math.abs(mid - relY);
          if (d < bestDist) {
            bestDist = d;
            idx = i;
          }
        });
        if (bestDist > 24) {
          this._stats.misses += 1;
          return;
        }
      }

      // 合并紧随其后的行（同一段的换行），但不超过 maxLines / maxChars
      const picked = [lines[idx]];
      for (let i = idx + 1; i < lines.length && picked.length < this._cfg.maxLines; i += 1) {
        const prev = picked[picked.length - 1];
        const gap = lines[i].y - (prev.y + (prev.h || 0));
        if (gap > (prev.h || 0) * 0.9) break; // 段间距明显变大 → 认为换段
        picked.push(lines[i]);
      }

      let text = tidyText(picked.map((l) => l.t).join(''));
      if (!text) {
        this._stats.misses += 1;
        return;
      }
      if (text.length > this._cfg.maxChars) text = text.slice(0, this._cfg.maxChars);

      this._stats.hits += 1;
      try {
        this._onText(text, {
          x: pos.x,
          y: pos.y,
          lines: picked.length,
          ocrMs: r.ms || 0,
          totalMs: this._stats.lastMs,
        });
      } catch (e) {
        /* 上层朗读异常不影响悬停循环 */
      }
    } catch (e) {
      this._stats.errors += 1;
      // 取词链路彻底不可用（引擎缺失等）时只说一次，且要说明「悬停已失效」
      if (!this._issueReported && this._stats.errors >= 2) {
        this._issueReported = true;
        this._onIssue('鼠标悬停取词不可用，请改用热键朗读。');
      }
    } finally {
      this._busyScanning = false;
    }
  }
}

module.exports = { HoverReader, tidyText, HOVER_DEFAULTS: DEFAULTS };
