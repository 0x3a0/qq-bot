// Focused probe: are EM push2delay values stable / real-time, and how do EM
// industry boards compare with Tencent's Shenwan-1 boards of the same name?
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
async function get(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": UA } });
    clearTimeout(t);
    return await r.text();
  } catch (e) {
    return "ERR:" + (e.cause?.code || e.message);
  }
}
const EM = "http://push2delay.eastmoney.com/api/qt/clist/get";
const Q = "pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2";

console.log("### A. same query twice, 4s apart — value stability ###");
const F = "f2,f3,f5,f6,f12,f14,f104,f105,f124,f128,f140";
const a = JSON.parse(await get(`${EM}?${Q}&fields=${F}`)).data.diff;
await new Promise((r) => setTimeout(r, 4000));
const b = JSON.parse(await get(`${EM}?${Q}&fields=${F}`)).data.diff;
let same = 0;
for (let i = 0; i < a.length; i++) if (a[i].f3 === b[i].f3 && a[i].f6 === b[i].f6) same++;
console.log(`  rows compared=${a.length} identical=${same} changed=${a.length - same}`);
console.log(`  run1 top3: ${a.slice(0, 3).map((d) => `${d.f14}=${d.f3}%/${(d.f6 / 1e8).toFixed(1)}亿`).join(" | ")}`);
console.log(`  run2 top3: ${b.slice(0, 3).map((d) => `${d.f14}=${d.f3}%/${(d.f6 / 1e8).toFixed(1)}亿`).join(" | ")}`);

console.log("\n### B. data timestamp field f124 ###");
const ts = JSON.parse(await get(`${EM}?pn=1&pz=3&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f12,f14,f124`)).data.diff;
ts.forEach((d) => {
  const iso = d.f124 ? new Date(d.f124 * 1000).toISOString() : "n/a";
  const bj = d.f124 ? new Date(d.f124 * 1000 + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) : "n/a";
  console.log(`  ${d.f14}: f124=${d.f124} -> UTC ${iso} / Beijing ${bj}`);
});
console.log(`  machine now = ${new Date().toISOString()} UTC`);

console.log("\n### C. EM board vs TX board of the SAME NAME ###");
const emAll = JSON.parse(await get(`${EM}?${Q}&fields=${F}`)).data.diff;
const tx = JSON.parse(
  await get("http://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hy&sort_type=price&direct=down&offset=0&count=100")
).data.rank_list;
console.log("  name           EM f3     EM f6        TX zdf    TX turnover(万)  TX -> 亿");
for (const d of tx) {
  const e = emAll.find((x) => x.f14 === d.name);
  console.log(
    `  ${d.name.padEnd(12)} ${String(e ? e.f3 : "-").padStart(7)}%  ${(e ? (e.f6 / 1e8).toFixed(1) : "-").padStart(8)}亿  ` +
      `${String(d.zdf).padStart(7)}%  ${String(d.turnover).padStart(12)}  ${(d.turnover / 1e4).toFixed(1)}亿`
  );
}
