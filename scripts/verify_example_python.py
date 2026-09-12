"""Verify the exact example from docs/DATA_SOURCE_A_SHARE_SECTOR.md works."""
import json
import urllib.parse
import urllib.request

BASE = "http://push2delay.eastmoney.com/api/qt/clist/get"
FIELDS = "f2,f3,f5,f6,f12,f14,f104,f105,f124,f128,f140"


def fetch_all_boards():
    """返回全部 496 个行业板块。共 5 次请求。"""
    boards, total = [], None
    for pn in range(1, 6):  # pz 上限 100 -> 496 条需 5 页
        qs = urllib.parse.urlencode({
            "pn": pn, "pz": 100, "po": 1, "np": 1,
            "fltt": 2, "invt": 2, "fid": "f3",
            "fs": "m:90+t:2",  # 行业板块；概念板块用 m:90+t:3
            "fields": FIELDS,
        })
        req = urllib.request.Request(BASE + "?" + qs,
                                     headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))["data"]
        total = data["total"]
        rows = data["diff"] or []  # 越界页可能返回 diff=None
        if not rows:
            break
        boards.extend(rows)
    assert len(boards) == total, (len(boards), total)
    return boards


boards = fetch_all_boards()
print(f"fetched={len(boards)}")

# field mapping sanity checks
assert all(isinstance(b["f3"], (int, float)) for b in boards), "f3 not numeric"
assert all(isinstance(b["f6"], (int, float)) for b in boards), "f6 not numeric"
assert all(isinstance(b["f14"], str) and b["f14"] for b in boards), "f14 missing"
assert len({b["f12"] for b in boards}) == len(boards), "f12 not unique"
print("all f3/f6 numeric, f14 non-empty, f12 unique  -> OK")

print(f"\n{'板块':<14}{'涨跌幅':>9}{'成交额':>12}  涨/跌      领涨股")
for b in sorted(boards, key=lambda x: -x["f6"])[:12]:
    print(f'{b["f14"]:<14}{b["f3"]:>8}%{b["f6"] / 1e8:>10.1f}亿  '
          f'{b["f104"]:>4}/{b["f105"]:<4}  {b["f128"]}')

total_turnover = sum(b["f6"] for b in boards) / 1e12
stamps = {b["f124"] for b in boards}
print(f"\nsum(f6) = {total_turnover:.2f} 万亿元")
print(f"distinct f124 timestamps = {stamps}")
print("\nEXIT: PASS")
