"""Squarified treemap layout.

Pure geometric algorithm with no third-party dependencies and no I/O, so it is
fully unit-testable offline.

Reference: Bruls, Huizing & van Wijk, "Squarified Treemaps" (2000).

The goal is to lay out weighted items inside a rectangle so that every tile is
as close to a square as possible: long thin slivers are hard to label and look
broken. Weights are normalised, then consumed greedily one row at a time; a row
is closed as soon as adding another item would make the worst aspect ratio in
that row worse than the best ratio achievable without it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

# Tiles thinner than this (in px) are not worth drawing or labelling; they also
# risk degenerate geometry. They are dropped during layout.
MIN_SIDE_PX = 1.0


@dataclass(frozen=True)
class Rect:
    """An axis-aligned rectangle in pixel space, origin at the top-left."""

    x: float
    y: float
    width: float
    height: float

    @property
    def area(self) -> float:
        return self.width * self.height

    @property
    def aspect(self) -> float:
        """Aspect ratio, always >= 1.0 (orientation-independent)."""
        if self.width <= 0 or self.height <= 0:
            return float("inf")
        return max(self.width / self.height, self.height / self.width)


@dataclass(frozen=True)
class Tile:
    """A laid-out item: its original index, its rectangle, and its weight."""

    index: int
    rect: Rect
    weight: float


def _layout_row(
    row: Sequence[tuple[int, float]],
    x: float,
    y: float,
    width: float,
    height: float,
    scale: float,
    vertical: bool,
) -> list[Tile]:
    """Place one row of items along the shorter side of the free rectangle.

    When ``vertical`` the row fills a column (items stacked top-to-bottom),
    otherwise it fills a horizontal band (items laid left-to-right).
    """
    tiles: list[Tile] = []
    row_weight = sum(w for _, w in row)
    if row_weight <= 0:
        return tiles

    if vertical:
        # Column occupying a slice of width; items stacked by height.
        col_width = (row_weight * scale) / height
        cursor = y
        for index, weight in row:
            item_height = (weight * scale) / col_width
            tiles.append(Tile(index, Rect(x, cursor, col_width, item_height), weight))
            cursor += item_height
        return tiles

    # Band occupying a slice of height; items laid out by width.
    band_height = (row_weight * scale) / width
    cursor = x
    for index, weight in row:
        item_width = (weight * scale) / band_height
        tiles.append(Tile(index, Rect(cursor, y, item_width, band_height), weight))
        cursor += item_width
    return tiles


def _worst_aspect(
    row: Sequence[tuple[int, float]],
    side: float,
    scale: float,
) -> float:
    """Worst aspect ratio if this row were placed against ``side``.

    ``side`` is the length of the free rectangle's shorter edge, which is the
    edge the row is laid along.
    """
    total = sum(w for _, w in row)
    if total <= 0 or side <= 0:
        return float("inf")
    row_thickness = (total * scale) / side
    if row_thickness <= 0:
        return float("inf")
    worst = 0.0
    for _, weight in row:
        length = (weight * scale) / row_thickness
        if length <= 0:
            return float("inf")
        ratio = max(length / row_thickness, row_thickness / length)
        worst = max(worst, ratio)
    return worst


def squarify(
    weights: Sequence[float],
    width: float,
    height: float,
) -> list[Tile]:
    """Lay out ``weights`` inside a ``width`` x ``height`` rectangle.

    Items are sorted by descending weight (the algorithm requires it for the
    squarified property); the returned tiles carry the *original* index so
    callers can map results back to their own item list.

    Zero or negative weights are skipped. Tiles narrower than ``MIN_SIDE_PX``
    in either dimension are dropped, since they would be invisible anyway.
    """
    if width <= 0 or height <= 0:
        raise ValueError("width and height must be positive")

    indexed = [(i, float(w)) for i, w in enumerate(weights) if float(w) > 0]
    if not indexed:
        return []

    indexed.sort(key=lambda pair: pair[1], reverse=True)
    total_weight = sum(w for _, w in indexed)
    scale = (width * height) / total_weight

    tiles: list[Tile] = []
    free_x, free_y, free_w, free_h = 0.0, 0.0, width, height
    position = 0

    while position < len(indexed):
        vertical = free_w >= free_h
        side = free_h if vertical else free_w

        row: list[tuple[int, float]] = []
        best = float("inf")
        while position + len(row) < len(indexed):
            candidate = indexed[position + len(row)]
            trial = row + [candidate]
            ratio = _worst_aspect(trial, side, scale)
            if row and ratio > best:
                break
            row = trial
            best = ratio

        row_tiles = _layout_row(row, free_x, free_y, free_w, free_h, scale, vertical)
        tiles.extend(row_tiles)

        # Shrink the free rectangle by the consumed row.
        if vertical:
            consumed = sum(w for _, w in row) * scale / free_h
            free_x += consumed
            free_w -= consumed
        else:
            consumed = sum(w for _, w in row) * scale / free_w
            free_y += consumed
            free_h -= consumed

        position += len(row)

        if free_w <= 0 or free_h <= 0:
            break

    return [
        tile
        for tile in tiles
        if tile.rect.width >= MIN_SIDE_PX and tile.rect.height >= MIN_SIDE_PX
    ]
