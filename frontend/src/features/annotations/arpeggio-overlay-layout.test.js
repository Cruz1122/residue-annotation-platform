import assert from 'node:assert/strict';
import test from 'node:test';
import { placeArpeggioOverlayLabels } from './arpeggio-overlay-layout.js';

function legacyLayout(items, width, height) {
  const placedRects = [];
  const scaleRect = { x: 8, y: height - 76, width: width - 16, height: 64 };
  const badgeRect = { x: 8, y: 8, width: 150, height: 54 };
  const intersects = (a, b) => a.x < b.x + b.width + 4
    && a.x + a.width + 4 > b.x
    && a.y < b.y + b.height + 4
    && a.y + a.height + 4 > b.y;
  const offsets = [0, -18, -36, -54, -72, -90, -108, 18, 36, 54];
  for (const item of items) {
    const textWidth = Math.max(16, item.label.length * 5.7 + 5);
    const anchorRight = item.x2 >= item.x1;
    const baseX = anchorRight ? item.x2 + 8 : item.x2 - 8;
    const baseY = item.y2 + 3;
    let chosen = null;
    for (const offset of offsets) {
      const x = anchorRight ? baseX : baseX - textWidth;
      const rect = { x, y: baseY + offset - 6, width: textWidth, height: 12 };
      if (rect.x < 6 || rect.x + rect.width > width - 6) continue;
      if (rect.y < 6 || rect.y + rect.height > height - 6) continue;
      if (intersects(rect, scaleRect) || intersects(rect, badgeRect)) continue;
      if (placedRects.some((placed) => intersects(rect, placed))) continue;
      chosen = { x, y: baseY + offset, rect };
      break;
    }
    if (!chosen) {
      const x = anchorRight ? baseX : baseX - textWidth;
      chosen = { x, y: baseY, rect: { x, y: baseY - 6, width: textWidth, height: 12 } };
    }
    placedRects.push(chosen.rect);
    item.textAnchor = anchorRight ? 'start' : 'end';
    item.labelX = anchorRight ? chosen.x : chosen.x + textWidth;
    item.labelY = chosen.y;
  }
  return items;
}

test('preserves label positions, anchors, and fallback behavior from the exhaustive layout', () => {
  const items = Array.from({ length: 180 }, (_, index) => {
    const x = 165 + ((index * 67) % 560);
    const y = 85 + ((index * 37) % 280);
    return { id: String(index), label: `A${index + 1}`, x1: x - 9, x2: x, y1: y - 5, y2: y };
  });
  const expected = legacyLayout(structuredClone(items), 800, 440);
  const actual = placeArpeggioOverlayLabels(structuredClone(items), { width: 800, height: 440 });
  assert.deepEqual(actual, expected);
});

test('handles empty and dense label groups', () => {
  assert.deepEqual(placeArpeggioOverlayLabels([], { width: 800, height: 440 }), []);
  const dense = Array.from({ length: 500 }, (_, index) => ({
    label: `R${index + 1}`,
    x1: 300,
    x2: 301,
    y1: 220,
    y2: 221,
  }));
  const expectedDense = legacyLayout(structuredClone(dense), 800, 440);
  const placed = placeArpeggioOverlayLabels(structuredClone(dense), { width: 800, height: 440 });
  assert.equal(placed.length, dense.length);
  assert.ok(placed.every((item) => Number.isFinite(item.labelX) && Number.isFinite(item.labelY)));
  assert.deepEqual(placed, expectedDense);
});

test('preserves distributed label placement when the spatial index is enabled', () => {
  const items = Array.from({ length: 900 }, (_, index) => {
    const x = 30 + ((index * 137) % 1540);
    const y = 30 + ((index * 193) % 840);
    return { label: `R${index + 1}`, x1: x - 8, x2: x, y1: y - 5, y2: y };
  });
  const expected = legacyLayout(structuredClone(items), 1600, 900);
  const actual = placeArpeggioOverlayLabels(structuredClone(items), { width: 1600, height: 900 });
  assert.deepEqual(actual, expected);
});
