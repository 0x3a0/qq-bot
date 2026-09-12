"""Invariant tests for the squarified treemap layout.

These assert structural properties that must hold for *any* input, which is
what makes the renderer trustworthy without eyeballing every image:

* area conservation - the tiles fill the canvas (no wasted or lost space)
* no overlap - tiles are disjoint
* containment - every tile lies inside the canvas
* ordering - items keep their sorted-by-weight order in the output
"""

from __future__ import annotations

import pytest

from treemap.layout import MIN_SIDE_PX, Tile, squarify

WIDTH, HEIGHT = 1600.0, 1000.0


def _overlap(a: Tile, b: Tile) -> bool:
    """True when two tiles share positive area (touching edges are fine)."""
    ax2, ay2 = a.rect.x + a.rect.width, a.rect.y + a.rect.height
    bx2, by2 = b.rect.x + b.rect.width, b.rect.y + b.rect.height
    return (
        min(ax2, bx2) - max(a.rect.x, b.rect.x) > 1e-6
        and min(ay2, by2) - max(a.rect.y, b.rect.y) > 1e-6
    )


def _assert_no_overlap(tiles: list[Tile]) -> None:
    for i, a in enumerate(tiles):
        for b in tiles[i + 1 :]:
            assert not _overlap(a, b), f"tiles {a.index} and {b.index} overlap"


def _assert_contained(tiles: list[Tile]) -> None:
    for tile in tiles:
        assert tile.rect.x >= -1e-6, f"tile {tile.index} starts left of canvas"
        assert tile.rect.y >= -1e-6, f"tile {tile.index} starts above canvas"
        assert tile.rect.x + tile.rect.width <= WIDTH + 1e-6, f"tile {tile.index} overflows right"
        assert tile.rect.y + tile.rect.height <= HEIGHT + 1e-6, f"tile {tile.index} overflows bottom"


class TestInvariants:
    @pytest.mark.parametrize(
        "weights",
        [
            [1.0],  # single item
            [1.0, 1.0],  # two equal items
            [3.0, 1.0],  # skewed pair
            [10.0, 8.0, 6.0, 4.0, 2.0, 1.0],  # classic Bruls example
            [100.0] * 11,  # US sectors: eleven equal weights
            [float(i) for i in range(1, 32)],  # A-share: 31 sectors, wide spread
            [1000.0, 1.0, 1.0, 1.0, 1.0],  # one dominant item, tiny tail
        ],
    )
    def test_area_is_conserved(self, weights: list[float]) -> None:
        """Tiles must tile the canvas exactly when nothing is dropped."""
        tiles = squarify(weights, WIDTH, HEIGHT)
        # Only meaningful when every item survived the min-side filter.
        if len(tiles) == len(weights):
            laid_out = sum(t.rect.area for t in tiles)
            assert laid_out == pytest.approx(WIDTH * HEIGHT, rel=1e-6)

    @pytest.mark.parametrize(
        "weights",
        [
            [1.0, 1.0],
            [10.0, 8.0, 6.0, 4.0, 2.0, 1.0],
            [100.0] * 11,
            [float(i) for i in range(1, 32)],
            [1000.0, 1.0, 1.0, 1.0, 1.0],
        ],
    )
    def test_tiles_do_not_overlap(self, weights: list[float]) -> None:
        _assert_no_overlap(squarify(weights, WIDTH, HEIGHT))

    @pytest.mark.parametrize(
        "weights",
        [
            [10.0, 8.0, 6.0, 4.0, 2.0, 1.0],
            [100.0] * 11,
            [float(i) for i in range(1, 32)],
        ],
    )
    def test_tiles_stay_inside_canvas(self, weights: list[float]) -> None:
        _assert_contained(squarify(weights, WIDTH, HEIGHT))

    def test_tile_area_is_proportional_to_weight(self) -> None:
        """A tile's area share must match its weight share."""
        weights = [4.0, 3.0, 2.0, 1.0]
        tiles = squarify(weights, WIDTH, HEIGHT)
        total = sum(weights)
        canvas = WIDTH * HEIGHT
        for tile in tiles:
            assert tile.rect.area == pytest.approx(canvas * tile.weight / total, rel=1e-6)

    def test_preserves_original_indices(self) -> None:
        """Output carries original indices even though sorting reorders items."""
        weights = [1.0, 50.0, 2.0]
        tiles = squarify(weights, WIDTH, HEIGHT)
        # Heaviest weight was index 1, so it must lead the output.
        assert tiles[0].index == 1
        assert {t.index for t in tiles} == {0, 1, 2}


class TestSquarifiedProperty:
    def test_aspect_ratios_stay_reasonable(self) -> None:
        """Squarification should avoid extreme slivers.

        The 6-item classic example is the canonical case where a naive
        slice-and-dice layout would produce ratios in the hundreds.
        """
        weights = [6.0, 6.0, 4.0, 3.0, 2.0, 2.0, 1.0]
        for tile in squarify(weights, WIDTH, HEIGHT):
            assert tile.rect.aspect < 8.0, f"tile {tile.index} is a sliver: {tile.rect}"

    def test_worst_aspect_beats_slice_and_dice(self) -> None:
        """The squarified layout must be strictly better than naive slicing."""
        weights = [float(i) for i in range(1, 32)]
        worst = max(t.rect.aspect for t in squarify(weights, WIDTH, HEIGHT))
        # A single horizontal strip per item would give the thinnest item a
        # height of HEIGHT * 1/496 and thus an enormous aspect ratio.
        naive_worst = WIDTH / (HEIGHT * 1.0 / sum(weights))
        assert worst < naive_worst

    def test_realistic_sector_distribution_is_well_squarified(self) -> None:
        """Real inputs must produce tiles that are pleasant to look at.

        Sector turnover spans roughly two orders of magnitude in practice
        (largest sector ~100x the smallest). Under those conditions every tile
        should stay close to square, which is the whole point of squarifying.
        """
        # 31 A-share sectors decaying geometrically, ~100:1 top-to-bottom.
        weights = [100.0 * (0.93**i) for i in range(31)]
        worst = max(t.rect.aspect for t in squarify(weights, WIDTH, HEIGHT))
        assert worst < 5.0, f"realistic distribution produced a sliver: {worst:.2f}"

    def test_extreme_weight_ratios_are_documented_as_a_limitation(self) -> None:
        """Pins the known limitation: pre-filter, do not feed raw long tails.

        With a 1000:1 ratio and a flat tail, the leftover strip is narrow, so
        stacking the tail items inside it necessarily yields elongated tiles.
        This test documents the boundary rather than pretending it is solved -
        callers are expected to pre-select sectors by turnover.
        """
        weights = [1000.0, 1.0, 1.0, 1.0, 1.0]
        worst = max(t.rect.aspect for t in squarify(weights, WIDTH, HEIGHT))
        assert worst > 5.0, "limitation no longer reproduces; revisit the layout"
        # The dominant tile itself must still be near-square.
        assert squarify(weights, WIDTH, HEIGHT)[0].rect.aspect < 2.0


class TestEdgeCases:
    def test_empty_input_returns_no_tiles(self) -> None:
        assert squarify([], WIDTH, HEIGHT) == []

    def test_all_zero_weights_returns_no_tiles(self) -> None:
        assert squarify([0.0, 0.0], WIDTH, HEIGHT) == []

    def test_negative_weights_are_ignored(self) -> None:
        tiles = squarify([-5.0, 10.0], WIDTH, HEIGHT)
        assert [t.index for t in tiles] == [1]

    def test_single_item_fills_the_canvas(self) -> None:
        (tile,) = squarify([42.0], WIDTH, HEIGHT)
        assert (tile.rect.x, tile.rect.y) == pytest.approx((0.0, 0.0))
        assert (tile.rect.width, tile.rect.height) == pytest.approx((WIDTH, HEIGHT))

    def test_rejects_non_positive_canvas(self) -> None:
        with pytest.raises(ValueError):
            squarify([1.0], 0.0, HEIGHT)

    def test_drops_invisible_slivers(self) -> None:
        """Items too thin to see are dropped rather than drawn as hairlines."""
        weights = [1e6] + [1e-3] * 50
        tiles = squarify(weights, WIDTH, HEIGHT)
        assert len(tiles) < 51
        for tile in tiles:
            assert tile.rect.width >= MIN_SIDE_PX
            assert tile.rect.height >= MIN_SIDE_PX
