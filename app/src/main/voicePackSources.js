// 外部资源集中 pin（本文件是全仓唯一的外部下载 URL 来源）。
// 背景：NVSA（NaturalVoiceSAPIAdapter）使用从系统文件提取的加密密钥解密 Narrator 语音，
// 微软商店更新版语音已更换密钥而失效；故全部 pin 到实测可用的「最后可用版本」。
// 密钥 / 直链失效时：只需改本文件（版本号 + URL + 字节数），其余代码零改动。
//
// 与 app/scripts/register-nvsa.ps1 的常量**逐字节一致**（URL / 文件名 / 字节数），
// 两处改动必须同步，否则「先跑脚本、后开应用」会重复下载或误判就绪。
'use strict';

/** @typedef {{id:string, displayName:string, msixVersion:string, fileName:string, sizeBytes:number, urls:string[], mirrorPages:string[], license:string}} VoicePackSource */

// ---- NaturalVoiceSAPIAdapter（SAPI5 语音适配器，MIT）----
// 实测：release 资产 zip（22,999,239 B）内 x64 引擎 DLL 为 x64\NaturalVoiceSAPIAdapter.dll，
// 即 regsvr32 注册目标；x86 目录对应 32 位 DLL（本应用为 x64 Electron，不需要）。
const NVSA = {
  name: 'NaturalVoiceSAPIAdapter',
  version: 'v0.2.10',
  license: 'MIT',
  licenseUrl: 'https://github.com/gexgd0419/NaturalVoiceSAPIAdapter/blob/master/LICENSE.txt',
  homepage: 'https://github.com/gexgd0419/NaturalVoiceSAPIAdapter',
  engineDllRelPath: 'x64/NaturalVoiceSAPIAdapter.dll', // zip 内相对路径（实测确认）
  asset: {
    fileName: 'NaturalVoiceSAPIAdapter_v0.2.10_x86_x64.zip',
    sizeBytes: 22999239,
    urls: [
      // 镜像优先：国内网络下 github.com 主页与 release 资产常直接不可达
      //（本机实测：github.com http=000、api 可取列表但资产下载超时）。
      // 两个镜像实测均支持 Range（206），可断点续传；字节数校验兜底，
      // 内容不对（含镜像投毒）会在 sizeBytes 校验阶段被拦下，不会进入解压/注册。
      'https://ghfast.top/https://github.com/gexgd0419/NaturalVoiceSAPIAdapter/releases/download/v0.2.10/NaturalVoiceSAPIAdapter_v0.2.10_x86_x64.zip',
      'https://gh-proxy.com/https://github.com/gexgd0419/NaturalVoiceSAPIAdapter/releases/download/v0.2.10/NaturalVoiceSAPIAdapter_v0.2.10_x86_x64.zip',
      // 官方直链放最后：能直连的环境仍优先走官方
      'https://github.com/gexgd0419/NaturalVoiceSAPIAdapter/releases/download/v0.2.10/NaturalVoiceSAPIAdapter_v0.2.10_x86_x64.zip',
    ],
  },
  // 人类可查的备用入口（页面非直链；直链失效时人工核对后补进 asset.urls）
  mirrorPages: ['https://github.com/gexgd0419/NaturalVoiceSAPIAdapter/releases'],
};

// ---- 微软 Narrator 自然语音 MSIX（NVDA 中文站托管的微软商店原始包，未修改）----
// 「最后可用版本」：商店新版语音已被微软更换解密密钥，NVSA 无法解密，故 pin 最后可用版本。
// 直链 302 跳转 SharePoint（tempauth 令牌会轮换，dl.nvdacn.com 入口稳定），下载器跟随重定向。
const VOICE_PACKS = [
  {
    id: 'xiaoxiao',
    displayName: '晓晓',
    msixVersion: '1.0.9.0',
    fileName: 'MicrosoftWindows.Voice.zh-CN.Xiaoxiao.1_1.0.9.0_x64__cw5n1h2txyewy.Msix',
    sizeBytes: 56815288,
    urls: [
      'https://dl.nvdacn.com/NVDA-Addons/TTS/NaturalVoices/MicrosoftWindows.Voice.zh-CN.Xiaoxiao.1_1.0.9.0_x64__cw5n1h2txyewy.Msix',
    ],
    mirrorPages: ['https://www.nvdacn.com/index.php/tts.html'],
    license:
      '微软商店原始 MSIX（Windows Narrator 语音资产；不修改、不随安装包分发，仅运行时下载到用户本机）',
  },
  {
    id: 'yunxi',
    displayName: '云希',
    msixVersion: '1.0.4.0',
    fileName: 'MicrosoftWindows.Voice.zh-CN.Yunxi.1_1.0.4.0_x64__cw5n1h2txyewy.Msix',
    sizeBytes: 63335105,
    urls: [
      'https://dl.nvdacn.com/NVDA-Addons/TTS/NaturalVoices/MicrosoftWindows.Voice.zh-CN.Yunxi.1_1.0.4.0_x64__cw5n1h2txyewy.Msix',
    ],
    mirrorPages: ['https://www.nvdacn.com/index.php/tts.html'],
    license:
      '微软商店原始 MSIX（Windows Narrator 语音资产；不修改、不随安装包分发，仅运行时下载到用户本机）',
  },
];

/** 每个 MSIX 解压后的子目录名（去掉 .msix 扩展名，纯 ASCII，满足 NVSA 路径要求） */
function msixDirName(pack) {
  return pack.fileName.replace(/\.msix$/i, '');
}

/** 装配失败分类码（与 voiceDeploy 的状态机一一对应） */
const VP_ERRORS = {
  NETWORK: 'VP_NETWORK', // 下载失败 / 体积不符
  EXTRACT: 'VP_EXTRACT', // 解压失败 / 解压结果不完整
  ELEVATION_DENIED: 'VP_ELEVATION_DENIED', // 用户取消 UAC
  NETFX3: 'VP_NETFX3', // .NET Framework 3.5 安装失败
  REGISTER: 'VP_REGISTER', // regsvr32 失败
  CONFIG: 'VP_CONFIG', // HKCU 配置写入失败
  VERIFY_FAILED: 'VP_VERIFY_FAILED', // 装配后枚举/试合成不通过
};

/**
 * 内置默认源的清单（W-VOICESRC）。
 *
 * 作用：把「硬编码 pin」表达成用户可见的同一套 manifest 结构，设置面板据此展示
 * 「内置源里有晓晓 / 云希」；voiceDeploy 也从这里取安装目标（files 列表），
 * 从而做到「安装目标来自清单」而不是散落的常量。
 *
 * 硬性约束：本函数产出的 voices 必须与下面 VOICE_PACKS **逐字段等价**
 * （key/displayName/fileName/sizeBytes/urls 顺序），否则内置源的安装结果
 * 就不等于改造前的三件套 —— 这是回归红线，改前先看 tmp_probe_WVOICESRC.js。
 *
 * `urls` 是 `url` 的镜像扩展（可选，数组）：第一个是主地址，其余为镜像。
 * 用户自建仓库同样可以用它写多个镜像；只有一个地址时写 `url` 即可。
 */
function defaultManifest() {
  return {
    schemaVersion: 1,
    name: '明读 内置音色源',
    voices: VOICE_PACKS.map((p) => ({
      key: p.id,
      displayName: p.displayName,
      gender: p.id === 'yunxi' ? 'male' : 'female',
      locale: 'zh-CN',
      engine: 'nvsa-sapi',
      requires: ['nvsa'],
      keywords: [p.id, p.displayName],
      files: [
        {
          url: p.urls[0],
          urls: p.urls.slice(),
          fileName: p.fileName,
          sizeBytes: p.sizeBytes,
        },
      ],
      license: p.license,
      homepage: p.mirrorPages && p.mirrorPages[0],
      version: p.msixVersion,
    })),
  };
}

/** 需要下载的全部资产（顺序即下载顺序；总字节用于整体进度） */
function downloadTargets() {
  return [
    {
      id: 'nvsa',
      label: `NaturalVoiceSAPIAdapter ${NVSA.version}`,
      urls: NVSA.asset.urls,
      fileName: NVSA.asset.fileName,
      sizeBytes: NVSA.asset.sizeBytes,
    },
    ...VOICE_PACKS.map((p) => ({
      id: p.id,
      label: `语音包 ${p.displayName}`,
      urls: p.urls,
      fileName: p.fileName,
      sizeBytes: p.sizeBytes,
    })),
  ];
}

/** 三项资产合计字节（约 137.9 MB，用于进度与会话内提示） */
const TOTAL_BYTES = downloadTargets().reduce((s, d) => s + (d.sizeBytes || 0), 0);

module.exports = {
  NVSA,
  VOICE_PACKS,
  msixDirName,
  VP_ERRORS,
  downloadTargets,
  TOTAL_BYTES,
  defaultManifest,
};
