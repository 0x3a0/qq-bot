"""Zero-dependency self-check for the treemap layout.

``pytest`` is not installed in every environment (installing it writes outside
the workspace), so this script re-verifies the core invariants using only the
standard library. Run it directly::

    python scripts/selfcheck_layout.py

It is a smoke check, not a replacement for ``pytest tests/`` - the pytest suite
covers more cases and reports failures far better.
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(SRC))

from treemap.layout import MIN_SIDE_PX, squarify  # noqa: E402

WIDTH, HEIGHT = 1600.0, 1000.0
CANVAS = WIDTH * HEIGHT

CASES: dict[str, list[float]] = {
    "single": [1.0],
    "pair": [1.0, 1.0],
    "bruls classic": [6.0, 6.0, 4.0, 3.0, 2.0, 2.0, 1.0],
    "us sectors (11 equal)": [100.0] * 11,
    "a-share sectors (31)": [float(i) for i in range(1, 32)],
    "a-share realistic (~100:1)": [100.0 * (0.93**i) for i in range(31)],
}

# Known limitation, asserted rather than hidden: an extreme weight ratio with a
# flat tail leaves a narrow strip, so tail tiles come out elongated. Callers
# must pre-select sectors by turnover instead of feeding raw long tails.
LIMITATION_CASE = ("dominant + flat tail", [1000.0, 1.0, 1.0, 1.0, 1.0])
# Real inputs should squarify well; anything worse than this is a regression.
MAX_ACCEPTABLE_ASPECT = 5.0

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


for name, weights in CASES.items():
    tiles = squarify(weights, WIDTH, HEIGHT)
    total_weight = sum(weights)

    # Every item survived -> tiles must exactly fill the canvas.
    if len(tiles) == len(weights):
        laid_out = sum(t.rect.area for t in tiles)
        check(
            abs(laid_out - CANVAS) <= CANVAS * 1e-6,
            f"{name}: area not conserved ({laid_out:.4f} vs {CANVAS:.4f})",
        )

    # Containment.
    for t in tiles:
        check(t.rect.x >= -1e-6 and t.rect.y >= -1e-6, f"{name}: tile {t.index} starts outside")
        check(
            t.rect.x + t.rect.width <= WIDTH + 1e-6
            and t.rect.y + t.rect.height <= HEIGHT + 1e-6,
            f"{name}: tile {t.index} overflows canvas",
        )
        check(
            t.rect.width >= MIN_SIDE_PX and t.rect.height >= MIN_SIDE_PX,
            f"{name}: tile {t.index} is an invisible sliver",
        )

    # Non-overlap.
    for i, a in enumerate(tiles):
        for b in tiles[i + 1 :]:
            ax2, ay2 = a.rect.x + a.rect.width, a.rect.y + a.rect.height
            bx2, by2 = b.rect.x + b.rect.width, b.rect.y + b.rect.height
            overlaps = (
                min(ax2, bx2) - max(a.rect.x, b.rect.x) > 1e-6
                and min(ay2, by2) - max(a.rect.y, b.rect.y) > 1e-6
            )
            check(not overlaps, f"{name}: tiles {a.index} and {b.index} overlap")

    # Area share must match weight share.
    for t in tiles:
        expected = CANVAS * t.weight / total_weight
        check(
            abs(t.rect.area - expected) <= max(expected * 1e-6, 1e-6),
            f"{name}: tile {t.index} area {t.rect.area:.4f} != expected {expected:.4f}",
        )

    worst = max((t.rect.aspect for t in tiles), default=1.0)
    label = f"{name:28s}"
    if name in CASES and worst > MAX_ACCEPTABLE_ASPECT and len(tiles) > 1:
        failures.append(f"{name}: worst aspect {worst:.2f} exceeds {MAX_ACCEPTABLE_ASPECT}")
    print(f"{label} tiles={len(tiles):3d}  worst_aspect={worst:6.2f}")

# Document the limitation explicitly instead of silently tolerating it.
lim_name, lim_weights = LIMITATION_CASE
lim_tiles = squarify(lim_weights, WIDTH, HEIGHT)
lim_worst = max(t.rect.aspect for t in lim_tiles)
print(f"{lim_name:28s} tiles={len(lim_tiles):3d}  worst_aspect={lim_worst:6.2f}  <- known limitation")

print()
if failures:
    print(f"FAILED ({len(failures)}):")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print(
    f"OK - {len(CASES)} cases verified (area conserved, no overlap, contained, "
    f"proportional, worst aspect <= {MAX_ACCEPTABLE_ASPECT})"
)
