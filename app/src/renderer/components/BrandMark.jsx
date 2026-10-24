// 品牌标记：与应用图标同一套图形（三行文字 + 两道声波），矢量内联。
//
// 为什么不用 resources/icon.png：位图在 2.0x 字号档会糊，且深/浅主题下无法微调对比度。
// 为什么不用 MUI 的 GraphicEq 图标：那只是一个「音频」符号，和产品图标不是同一个东西 ——
// 用户此前的评价是「看着像流氓软件鲁大师」，界面 logo 与任务栏图标必须是同一套语言。
//
// 配色固定为品牌紫渐变，不跟随主题：图标是品牌资产，深浅主题下都应保持同一识别度。
import React from 'react';
import { su } from '../theme';

export default function BrandMark({ size = 38, title = '明读' }) {
  const px = su(size);
  return (
    <svg
      viewBox="0 0 256 256"
      role="img"
      aria-label={title}
      // 宽高必须走 style：su() 返回 calc()，SVG 的 width/height 属性不解析 calc，
      // 会退化成默认 300x150 把顶栏撑变形。
      style={{ width: px, height: px, flexShrink: 0, display: 'block' }}
    >
      <defs>
        <linearGradient id="ldnBrandGrad" x1="0" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#8577ff" />
          <stop offset="1" stopColor="#6350f7" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="248" height="248" rx="50" fill="url(#ldnBrandGrad)" />
      {/* 三行文字：右端参差，避免被读成汉堡菜单 */}
      <rect x="40" y="92" width="96" height="16" rx="7" fill="#ffffff" />
      <rect x="40" y="120" width="66" height="16" rx="7" fill="#ffffff" opacity="0.9" />
      <rect x="40" y="148" width="82" height="16" rx="7" fill="#ffffff" opacity="0.78" />
      {/* 两道声波 */}
      <path
        d="M152 102 A 28 28 0 0 1 152 154"
        stroke="#ffffff"
        strokeWidth="16"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M182 80 A 66 66 0 0 1 182 176"
        stroke="#ffffff"
        strokeWidth="16"
        fill="none"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}
