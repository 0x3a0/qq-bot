// Verification probe for A-share industry-board data sources.
// Run: node scripts/verify_sector_sources.mjs
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function get(url, extra = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": UA, ...extra } });
    clearTimeout(t);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, buf, utf8: buf.toString("utf8") };
  } catch (e) {
    clearTimeout(t);
    return { err: e.cause?.code || e.cause?.message || e.message };
  }
}
const j = (r) => {
  try {
    return JSON.parse(r.utf8);
  } catch {
    return null;
  }
};

const EM = "http://push2delay.eastmoney.com/api/qt/clist/get";
const EM_Q =
  "po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f2,f3,f5,f6,f12,f14,f104,f105,f128,f140&pz=100";

console.log("########## 1. EM push2delay: full 496-board sweep ##########");
const all = [];
for (let pn = 1; pn <= 5; pn++) {
  const r = await get(`${EM}?${EM_Q}&pn=${pn}`);
  const jj = j(r);
  const rows = jj?.data?.diff || [];
  all.push(...rows);
  console.log(
    `  pn=${pn} HTTP ${r.status} total=${jj?.data?.total} rows=${rows.length} ` +
      `[${rows[0]?.f14 ?? "-"} .. ${rows[rows.length - 1]?.f14 ?? "-"}]`
  );
}
console.log(`  => accumulated=${all.length} unique=${new Set(all.map((x) => x.f12)).size}`);
console.log(`  => duplicate board names: ${all.length - new Set(all.map((x) => x.f14)).size}`);

console.log("\n########## 2. field semantics on one board ##########");
const probe = j(await get(`${EM}?pn=1&pz=1&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f1,f2,f3,f4,f5,f6,f7,f8,f12,f13,f14,f20,f21,f104,f105,f128,f140`));
console.log("  raw:", JSON.stringify(probe?.data?.diff?.[0]));
const row = probe?.data?.diff?.[0];
if (row) {
  console.log(`  f2=${row.f2} (index points)  f3=${row.f3} (pct)  f5=${row.f5} (volume, shares)`);
  console.log(`  f6=${row.f6} = ${(row.f6 / 1e8).toFixed(2)} 亿元  <-- TURNOVER`);
  console.log(`  implied avg price f6/f5 = ${(row.f6 / row.f5).toFixed(2)} CNY/share`);
}

console.log("\n########## 3. EM turnover totals vs other sectors ##########");
const sorted = [...all].sort((a, b) => b.f6 - a.f6);
console.log("  top5 by f6:");
sorted.slice(0, 5).forEach((d) => console.log(`    ${d.f14.padEnd(12)} ${String(d.f3).padStart(6)}%  ${(d.f6 / 1e8).toFixed(1)}亿`));
console.log(`  sum(all ${all.length}) = ${(all.reduce((a, b) => a + b.f6, 0) / 1e8 / 1e4).toFixed(2)} 万亿`);

console.log("\n########## 4. Tencent getRank ##########");
for (const [bt, st] of [
  ["hy", "price"],
  ["hy", "turnover"],
  ["hy2", "price"],
  ["hy2", "percent"],
  ["gn", "price"],
  ["dy", "price"],
]) {
  const url = `http://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=${bt}&sort_type=${st}&direct=down&offset=0&count=100`;
  const r = await get(url);
  const jj = j(r);
  if (jj?.data) {
    console.log(`  board_type=${bt} sort=${st}: HTTP ${r.status} total=${jj.data.total} returned=${jj.data.rank_list.length} first=${jj.data.rank_list[0]?.name ?? "-"}`);
  } else {
    console.log(`  board_type=${bt} sort=${st}: HTTP ${r.status} body=${(r.utf8 || r.err || "").slice(0, 120)}`);
  }
}
const tx = j(await get("http://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hy&sort_type=price&direct=down&offset=0&count=100"));
console.log("  full record:", JSON.stringify(tx?.data?.rank_list?.[0]));

console.log("\n########## 5. cross-source agreement (EM f3 vs TX zdf) ##########");
let hit = 0;
const diff = [];
for (const d of tx?.data?.rank_list || []) {
  const e = all.find((x) => x.f14 === d.name);
  if (!e) continue;
  if (Math.abs(e.f3 - parseFloat(d.zdf)) < 0.005) hit++;
  else diff.push(`${d.name}: EM=${e.f3} TX=${d.zdf}`);
}
console.log(`  matched=${hit} mismatched=${diff.length}`);
if (diff.length) console.log("  " + diff.slice(0, 6).join(" ; "));

console.log("\n########## 6. Sina industry board ##########");
const sina = await get("http://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php");
if (sina.buf) {
  const gbk = new TextDecoder("gbk").decode(sina.buf);
  const pairs = gbk.match(/"[^"]+":"[^"]*"/g) || [];
  console.log(`  HTTP ${sina.status} entries=${pairs.length}`);
  pairs.slice(0, 3).forEach((p) => console.log("   " + p));
}

console.log("\n########## 7. Xueqiu / Baidu ##########");
for (const [n, u] of [
  ["xueqiu screener", "http://stock.xueqiu.com/v5/stock/screener/quote/list.json?page=1&size=5&order=desc&order_by=percent&market=CN&type=industry"],
  ["baidu gushitong", "http://finance.pae.baidu.com/vapi/v1/getquotation?group=quotation_industry&code=industry&market_type=ab&finClientType=pc"],
]) {
  const r = await get(u);
  console.log(`  [${n}] HTTP ${r.status || "ERR:" + r.err} :: ${(r.utf8 || "").replace(/\s+/g, " ").slice(0, 150)}`);
}
