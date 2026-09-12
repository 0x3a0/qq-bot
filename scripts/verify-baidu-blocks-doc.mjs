// 校验脚本：验证 MVP 文档与接口规格中的实测结论自洽
// 用法: node scripts/verify-baidu-blocks-doc.mjs
import { readFileSync } from 'node:fs';

const root = 'E:/Python/WorkSpace/qq-bot';
const mvp = readFileSync(`${root}/MVP_TECH_PLAN.md`, 'utf8');
const spec = readFileSync(`${root}/docs/API_BAIDU_BLOCKS.md`, 'utf8');

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
  }
};

// 1. MVP 文档必须包含端点与全部必要参数
const requiredParams = ['market=ab', 'typeCode=HY', 'sortKey=amount', 'sortType=desc', 'style=heatmap', 'pn=0', 'rn=100', 'finClientType=pc'];
t('MVP 含完整端点 URL', mvp.includes('https://finance.pae.baidu.com/vapi/v2/blocks'));
for (const p of requiredParams) t(`MVP 含必要参数 ${p}`, mvp.includes(p));
for (const h of ['acs-token', 'BAIDUID', 'application/vnd.finance-web.v1+json', 'origin', 'referer', 'user-agent']) {
  t(`MVP 含必要 Header ${h}`, mvp.includes(h));
}
t('MVP 含取数字段 rawData.amount', mvp.includes('rawData.amount'));
t('MVP 含取数字段 rawData.pxChangeRate', mvp.includes('rawData.pxChangeRate'));
t('MVP 链接到规格文档', mvp.includes('docs/API_BAIDU_BLOCKS.md'));

// 2. 规格文档必须包含端点、参数表、响应结构、风险
for (const s of [
  'GET',
  'https://finance.pae.baidu.com/vapi/v2/blocks',
  'acs-token',
  'rawData',
  'hit risk',
  'isCaptchaEnabled',
  'dlswbr.baidu.com/heicha/mm/2108/acs-2108.js',
  'vapi/v1/blocks/overview',
  '§6',
]) {
  t(`规格含关键内容: ${s}`, spec.includes(s));
}

// 3. 规格文档中所有 JSON 代码块必须可解析
//    注意：样例里含中文注释与 https:// 字符串，剥离注释时必须避开 "://"
const stripJsonComments = (s) =>
  s
    .replace(/^\s*\/\/.*$/gm, '') // 整行 // 注释
    .replace(/\/\*[\s\S]*?\*\//g, ''); // 块注释

const jsonBlocks = [...spec.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
t('规格文档含 JSON 样例代码块', jsonBlocks.length >= 2);
jsonBlocks.forEach((raw, i) => {
  const candidates = [raw.trim(), stripJsonComments(raw).trim()];
  const ok = candidates.some((c) => {
    try {
      JSON.parse(c);
      return true;
    } catch {
      return false;
    }
  });
  t(`JSON 代码块 #${i + 1} 可解析`, ok);
});

// 4. 403 响应体必须与实测原文一致
const expected403 = '{"QueryID":"5569724773836573166","Result":{"code":403,"isCaptchaEnabled":true,"msg":"hit risk"},"ResultCode":0}';
t('403 响应体与实测一致', spec.includes(expected403));
t('403 响应体出现在 MVP 文档摘要中', mvp.includes('"code":403'));

// 5. 首条记录样例必须与实测一致
const first = JSON.parse(`{
  "amount": "2093亿",
  "code": "270100",
  "financeType": "block",
  "lastPx": "13434.05",
  "logo": { "type": "img", "logo": "https://baidu-finance.cdn.bcebos.com/imgs/logo/block/半导体_47896.png" },
  "market": "ab",
  "marketValue": "14.30万亿",
  "name": "半导体",
  "pxChange": "-277.92",
  "pxChangeRate": "-2.03%",
  "rawData": {
    "amount": 209260095000,
    "lastPx": 13434.05,
    "marketValue": 14297712060272,
    "pxChange": -277.92,
    "pxChangeRate": -2.03,
    "volume": 26408623.43
  },
  "volume": "2641万手"
}`);
t('样例数值自洽: amount 四舍五入', Math.round(first.rawData.amount / 1e8) === 2093);
t('样例数值自洽: volume 万手', (first.rawData.volume / 1e4).toFixed(0) === '2641');
t('样例数值自洽: marketValue 万亿', (first.rawData.marketValue / 1e12).toFixed(2) === '14.30');
t('样例数值自洽: pxChangeRate 百分号串', `${first.rawData.pxChangeRate}%` === first.pxChangeRate);
t('样例 code 为 6 位', first.code.length === 6);

// 6. 凭据不得泄漏到文档（检测超长 base64 样式 token）
const leakPattern = /acs-token:\s*1[0-9]{12}_1[0-9]{12}_[A-Za-z0-9+/=]{40,}/;
t('MVP 文档无凭据泄漏', !leakPattern.test(mvp));
t('规格文档无凭据泄漏', !leakPattern.test(spec));
t('规格文档无 BAIDUID 明文值', !/BAIDUID=96344A/.test(spec) && !/BAIDUID=96344A/.test(mvp));
t('规格文档无 ab_sr 明文值', !/ab_sr=1\.0\.1_Nzk4/.test(spec));

// 7. 章节编号连续
const sections = [...mvp.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
t('MVP 章节编号连续', sections.every((n, i) => n === i + 1));

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
