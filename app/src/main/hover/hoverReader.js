// 鼠标悬停朗读：指针停在文字上读出「指针下的那一块」。
//
// 设计目标是对齐 macOS 的 Hover Text / 朗读指针下的项目：
//   · 粒度是**元素/段落级**，不是「读一行」更不是「一个字一个字蹦」；
//   · 有**详细度** Low/Medium/High（macOS 原样有这个设置）；
//   · 读到哪，屏幕上有**高亮框**（macOS 有 element highlight 颜色设置）；
//   · 触发可调延迟，另可切成「按住修饰键才读」。
//
// 为什么做不到 macOS 那么准：macOS 用 AX 命中测试直接拿到「元素」，
// 我们做过实测——Chromium 上 UIA 连 TextPattern 都拿不到（显式启用 + 5 次查询仍只有 Pane）。
// 所以只能用 OCR 的行，再**按行距/缩进聚合成视觉段落**来逼近「元素」。
// 这是能力差异，不是实现偷懒，界面上要如实告诉用户。
//
// 触发判定用**累计位移**而不是相邻采样差：低视力用户常伴手抖，
// 用相邻差判定会每 120ms 被重置一次，永远触发不了（这是上一版的实际缺陷）。
'use strict';

const { screen } = require('electron');

const DEFAULTS = {
  hoverDelayMs: 600, // 停多久触发
  pollMs: 120, // 轮询周期
  moveTolerancePx: 12, // 停留窗口内允许的累计位移（物理像素；手抖用户可放到 20）
  samePosPx: 28, // 触发后需离开多远才允许再次触发
  cooldownMs: 1200, // 两次朗读最小间隔
  regionW: 900, // 截图区域（物理像素）
  regionH: 420,
  detail: 'medium', // low 句 / medium 段 / high 段+后续
  maxChars: { low: 80, medium: 200, high: 400 },
  failHintAfter: 3, // 连续这么多次取不到文字，提示一次
};

// 中文之间的空格是 OCR 按 word 切分留下的，读起来会变成「一 个 字 一 个 字」
const CJK = '\\u4e00-\\u9fa5\\u3000-\\u303f\\uff00-\\uffef';
const CJK_GAP_RE = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g');

/** 清理 OCR 文本：合并汉字间空格、压缩多余空白 */
function tidyText(raw) {
  let t = String(raw || '').replace(/\u00a0/g, ' ');
  for (let i = 0; i < 4; i += 1) t = t.replace(CJK_GAP_RE, '$1');
  return t.replace(/[ \t]{2,}/g, ' ').trim();
}

/** 跨行合并：中文直接接，英文/数字之间补空格（join('') 对英文是错的） */
function joinLines(lines) {
  let out = '';
  for (const l of lines) {
    const piece = tidyText(l.t);
    if (!piece) continue;
    if (!out) {
      out = piece;
      continue;
    }
    const prev = out[out.length - 1];
    const next = piece[0];
    const ascii = (ch) => /[A-Za-z0-9]/.test(ch);
    out += ascii(prev) && ascii(next) ? ' ' + piece : piece;
  }
  // 行末连字符断词：hello- / world → helloworld
  return out.replace(/([A-Za-z])-\s+([a-z])/g, '$1$2');
}

/** 句子切分：优先用系统分词（懂缩写/省略号），失败退回标点规则 */
function splitSentences(text) {
  if (!text) return [];
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const seg = new Intl.Segmenter('zh', { granularity: 'sentence' });
      const out = [];
      for (const s of seg.segment(text)) {
        if (s && s.segment && s.segment.trim()) out.push({ text: s.segment, index: s.index });
      }
      if (out.length) return out;
    }
  } catch (e) {
    /* 落到标点切分 */
  }
  const out = [];
  const re = /[^。！？!?；;…]+[。！？!?；;…]*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) out.push({ text: m[0], index: m.index });
  }
  return out.length ? out : [{ text, index: 0 }];
}

/** 两行是否属于同一视觉段落：行距不能太大，左边界不能差太多 */
function sameBlock(a, b) {
  const lineH = Math.max(a.h || 0, 8);
  const gap = (b.y || 0) - ((a.y || 0) + (a.h || 0));
  if (gap > lineH * 1.0) return false; // 段间距（约一个行高以上就断开）
  if (gap < -lineH * 2) return false; // 重叠异常（多列串行）
  // 左边界：缩进差超过 2 个字高视为不同块；居中文本容差更宽
  const dx = Math.abs((a.x || 0) - (b.x || 0));
  if (dx > Math.max(lineH * 2.2, 40)) return false;
  return true;
}

/** 从命中行向上下扩展成视觉段落 */
function clusterParagraph(lines, index) {
  const seg = [lines[index]];
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!sameBlock(lines[i], seg[0])) break;
    seg.unshift(lines[i]);
  }
  for (let i = index + 1; i < lines.length; i += 1) {
    if (!sameBlock(seg[seg.length - 1], lines[i])) break;
    seg.push(lines[i]);
  }
  return seg;
}

/** 指针落在哪一行：优先命中区间，否则取最近的（容差 24px） */
function pickLine(lines, relY) {
  const idx = lines.findIndex((l) => relY >= l.y && relY <= l.y + (l.h || 0));
  if (idx >= 0) return idx;
  let best = -1;
  let bestDist = Infinity;
  lines.forEach((l, i) => {
    const mid = l.y + (l.h || 0) / 2;
    const d = Math.abs(mid - relY);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return bestDist <= 24 ? best : -1;
}

/** 把段落行转成屏幕坐标的矩形（供高亮用） */
function toRects(seg, origin) {
  return seg.map((l) => ({
    x: Math.round(origin.x + (l.x || 0)),
    y: Math.round(origin.y + (l.y || 0)),
    w: Math.round(l.w || 0),
    h: Math.round(l.h || 0),
  }));
}

class HoverReader {
  /**
   * @param {object} opts
   * @param {object} opts.ocr OcrHost 实例
   * @param {(text: string, meta: object) => void} opts.onText 命中文本（meta 带 rects / detail / sentences）
   * @param {() => boolean} [opts.isBusy] 正在朗读时返回 true（跳过本次悬停）
   * @param {(msg: string) => void} [opts.onIssue] 故障播报
   * @param {(px: number, py: number) => boolean} [opts.isSelfPoint] 指针是否在本应用窗口上
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
    this._stayX = null; // 停留窗口的起点（累计位移的基准）
    this._stayY = null;
    this._staySince = 0;
    this._firedPos = null;
    this._lastReadAt = 0;
    this._busy = false;
    this._running = false;
    this._consecutiveMiss = 0;
    this._hintShown = false;
    this._stats = { ticks: 0, hits: 0, misses: 0, errors: 0, lastMs: 0, lastDetail: '' };
  }

  get stats() {
    return { ...this._stats };
  }

  setDetail(level) {
    if (this._cfg.maxChars[level]) this._cfg.detail = level;
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
    this._stayX = null;
    this._firedPos = null;
  }

  dispose() {
    this.stop();
  }

  _cursorPhysical() {
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    const sf = (d && d.scaleFactor) || 1;
    return { x: Math.round(p.x * sf), y: Math.round(p.y * sf), sf, display: d };
  }

  _tick() {
    if (!this._running || this._busy) return;
    this._stats.ticks += 1;
    const now = Date.now();
    const pos = this._cursorPhysical();

    if (this._stayX === null) {
      this._stayX = pos.x;
      this._stayY = pos.y;
      this._staySince = now;
      return;
    }

    // 累计位移：相对停留起点，而不是相对上一次采样
    const drift = Math.max(Math.abs(pos.x - this._stayX), Math.abs(pos.y - this._stayY));
    if (drift > this._cfg.moveTolerancePx) {
      this._stayX = pos.x;
      this._stayY = pos.y;
      this._staySince = now;
      if (this._firedPos) {
        const far =
          Math.abs(pos.x - this._firedPos.x) > this._cfg.samePosPx ||
          Math.abs(pos.y - this._firedPos.y) > this._cfg.samePosPx;
        if (far) this._firedPos = null;
      }
      return;
    }

    if (this._isSelfPoint(pos.x, pos.y)) return;
    if (now - this._staySince < this._cfg.hoverDelayMs) return;
    if (this._firedPos) return;
    if (now - this._lastReadAt < this._cfg.cooldownMs) return;
    if (this._isBusy()) return;

    this._firedPos = pos;
    this._lastReadAt = now;
    this._scan(pos);
  }

  async _scan(pos) {
    this._busy = true;
    const t0 = Date.now();
    try {
      const { regionW, regionH } = this._cfg;
      const origin = {
        x: Math.max(0, pos.x - Math.round(regionW / 2)),
        y: Math.max(0, pos.y - Math.round(regionH / 2)),
      };
      const r = await this._ocr.recognize({ x: origin.x, y: origin.y, w: regionW, h: regionH });
      this._stats.lastMs = Date.now() - t0;

      const lines = (r.lines || []).filter((l) => l && l.t && String(l.t).trim());
      if (!lines.length) {
        this._miss();
        return;
      }

      const relY = pos.y - origin.y;
      const idx = pickLine(lines, relY);
      if (idx < 0) {
        this._miss();
        return;
      }

      // 1) 先聚成「视觉段落」（对齐 macOS 的段落/元素级）
      const seg = clusterParagraph(lines, idx);

      // 2) 合并成文本，并记录每行字符区间，用于把「指针位置」映射到句子
      let acc = 0;
      const spans = seg.map((l) => {
        const txt = tidyText(l.t);
        const start = acc;
        acc += txt.length;
        return { line: l, start, end: acc, text: txt };
      });
      const full = spans.map((s) => s.text).join('');

      // 3) 切句，找到指针所在的那一句
      const sentences = splitSentences(full);
      const hitSpan =
        spans.find((s) => relY >= s.line.y && relY <= s.line.y + (s.line.h || 0)) || spans[0];
      let hitSentence = sentences[0];
      for (const s of sentences) {
        const end = s.index + s.text.length;
        if (hitSpan.start >= s.index && hitSpan.start < end) {
          hitSentence = s;
          break;
        }
      }

      // 4) 按详细度决定读多少
      const detail = this._cfg.detail;
      let text;
      let usedSeg = seg;
      if (detail === 'low') {
        text = hitSentence ? hitSentence.text : full;
      } else if (detail === 'high') {
        // 高：本段 + 后续最多 2 段
        const nextStart = lines.indexOf(seg[seg.length - 1]) + 1;
        usedSeg = [...seg];
        let cursor = nextStart;
        let extra = 0;
        while (cursor < lines.length && extra < 2) {
          const more = clusterParagraph(lines, cursor);
          if (!more.length) break;
          usedSeg = usedSeg.concat(more);
          cursor += more.length;
          extra += 1;
        }
        text = full;
        for (const m of usedSeg.slice(seg.length)) {
          const piece = tidyText(m.t);
          if (piece) text += /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(piece) ? ' ' + piece : piece;
        }
      } else {
        text = full;
      }

      text = tidyText(text);
      const cap = this._cfg.maxChars[detail] || 200;
      let truncated = false;
      if (text.length > cap) {
        // 超长：优先在句末截，其次逗号，最后硬截
        const cut = Math.max(
          text.lastIndexOf('。', cap),
          text.lastIndexOf('！', cap),
          text.lastIndexOf('？', cap)
        );
        if (cut > cap * 0.4) {
          text = text.slice(0, cut + 1);
        } else {
          const comma = Math.max(text.lastIndexOf('，', cap), text.lastIndexOf('、', cap));
          text = comma > cap * 0.4 ? text.slice(0, comma + 1) : text.slice(0, cap);
        }
        truncated = true;
      }

      if (!text.trim()) {
        this._miss();
        return;
      }

      this._consecutiveMiss = 0;
      this._stats.hits += 1;
      this._stats.lastDetail = detail;

      // 5) 高亮矩形：读的是哪一块，屏幕上要看得见（macOS 的 element highlight）
      const rects = toRects(usedSeg, origin);

      try {
        this._onText(text, {
          x: pos.x,
          y: pos.y,
          detail,
          truncated,
          sentences: sentences.length,
          lines: usedSeg.length,
          rects,
          ocrMs: r.ms || 0,
          totalMs: this._stats.lastMs,
        });
      } catch (e) {
        /* 上层异常不影响悬停循环 */
      }
    } catch (e) {
      this._stats.errors += 1;
      if (this._stats.errors >= 2 && !this._hintShown) {
        this._hintShown = true;
        this._onIssue('悬停取词不可用，可以先用热键朗读。');
      }
    } finally {
      this._busy = false;
    }
  }

  _miss() {
    this._stats.misses += 1;
    this._consecutiveMiss += 1;
    // 连续多次取不到文字才提示一次：悬停是高频动作，每次都提示会变噪音
    if (this._consecutiveMiss === this._cfg.failHintAfter && !this._hintShown) {
      this._hintShown = true;
      this._onIssue('这里没有识别到文字，把指针放到正文上再试。');
    }
  }
}

module.exports = {
  HoverReader,
  tidyText,
  joinLines,
  splitSentences,
  clusterParagraph,
  sameBlock,
  pickLine,
  HOVER_DEFAULTS: DEFAULTS,
};
