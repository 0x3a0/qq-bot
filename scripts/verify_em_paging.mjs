// Determine the exact pagination behaviour of EM push2delay clist:
// what does omitting/altering pn do, and is pz capped at 100?
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
async function get(u) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(u, { signal: c.signal, headers: { "User-Agent": UA } });
    clearTimeout(t);
    return JSON.parse(await r.text());
  } catch (e) {
    return { err: e.cause?.code || e.message };
  }
}
const B = "http://push2delay.eastmoney.com/api/qt/clist/get?po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f6,f12,f14";

const show = (j, tag) => {
  const d = j?.data?.diff || [];
  console.log(
    `${tag.padEnd(34)} total=${String(j?.data?.total).padStart(4)} rows=${String(d.length).padStart(4)} ` +
      `first=${d[0]?.f14 ?? "-"} last=${d[d.length - 1]?.f14 ?? "-"}`
  );
  return d;
};

console.log("### pz sweep WITHOUT pn ###");
for (const pz of [5, 50, 100, 101, 150, 200, 500, 1000]) {
  show(await get(`${B}&pz=${pz}`), `no pn, pz=${pz}`);
}
console.log("\n### pz=100 WITH explicit pn ###");
const p1 = show(await get(`${B}&pz=100&pn=1`), "pz=100 pn=1");
show(await get(`${B}&pz=100&pn=2`), "pz=100 pn=2");
show(await get(`${B}&pz=100&pn=5`), "pz=100 pn=5");
show(await get(`${B}&pz=100&pn=6`), "pz=100 pn=6");

console.log("\n### pz=101..150 WITH pn=2 (does pz>100 break paging?) ###");
for (const pz of [101, 150]) {
  const d = show(await get(`${B}&pz=${pz}&pn=2`), `pz=${pz} pn=2`);
  console.log(`    (pn=1 with pz=${pz} first=${(await get(`${B}&pz=${pz}&pn=1`)).data.diff[0]?.f14})`);
}

console.log("\n### is pn=1 sorted by f3 desc? check monotonicity ###");
let bad = 0;
for (let i = 1; i < p1.length; i++) if (p1[i].f3 > p1[i - 1].f3) bad++;
console.log(`  pn=1 desc-violations=${bad}/${p1.length - 1} => ${bad === 0 ? "SORTED by f3 desc" : "NOT sorted"}`);
console.log(`  pn=1 first3=${p1.slice(0, 3).map((d) => `${d.f14}:${d.f3}`).join(", ")}`);

console.log("\n### other fid sort options (verify fid works) ###");
for (const fid of ["f3", "f6", "f12", "f14", "f104"]) {
  const j = await get(`${B}&pz=3&pn=1&fid=${fid}`);
  console.log(`  fid=${fid}: ${(j?.data?.diff || []).map((d) => `${d.f14}(${d.f3}%/${(d.f6 / 1e8).toFixed(0)}亿)`).join(" , ")}`);
}
