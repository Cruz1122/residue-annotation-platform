const CELL_SIZE = 64;
const LABEL_GAP = 4;
const LABEL_OFFSETS = [0, -18, -36, -54, -72, -90, -108, 18, 36, 54];
const SPATIAL_INDEX_MIN_ITEMS = 768;
const MAX_ITEMS_PER_ENDPOINT_CELL = 8;

function intersects(left, right) {
  return left.x < right.x + right.width + LABEL_GAP
    && left.x + left.width + LABEL_GAP > right.x
    && left.y < right.y + right.height + LABEL_GAP
    && left.y + left.height + LABEL_GAP > right.y;
}

function visitCells(rect, callback) {
  const minX = Math.floor((rect.x - LABEL_GAP) / CELL_SIZE);
  const maxX = Math.floor((rect.x + rect.width + LABEL_GAP) / CELL_SIZE);
  const minY = Math.floor((rect.y - LABEL_GAP) / CELL_SIZE);
  const maxY = Math.floor((rect.y + rect.height + LABEL_GAP) / CELL_SIZE);
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      if (callback(`${x}:${y}`) === false) return;
    }
  }
}

function shouldUseSpatialIndex(items) {
  if (items.length < SPATIAL_INDEX_MIN_ITEMS) return false;
  const occupiedEndpointCells = new Set();
  for (const item of items) {
    occupiedEndpointCells.add(`${Math.floor(item.x2 / CELL_SIZE)}:${Math.floor(item.y2 / CELL_SIZE)}`);
  }
  return items.length <= occupiedEndpointCells.size * MAX_ITEMS_PER_ENDPOINT_CELL;
}

function placeWithLinearScan(items, width, height) {
  const placedRects = [];
  const scaleRect = { x: 8, y: height - 76, width: width - 16, height: 64 };
  const badgeRect = { x: 8, y: 8, width: 150, height: 54 };
  for (const item of items) {
    const textWidth = Math.max(16, String(item.label ?? '').length * 5.7 + 5);
    const anchorRight = item.x2 >= item.x1;
    const baseX = anchorRight ? item.x2 + 8 : item.x2 - 8;
    const baseY = item.y2 + 3;
    let chosen = null;
    for (const offset of LABEL_OFFSETS) {
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

/**
 * Position ARPEGGIO labels while limiting overlap checks to nearby screen cells.
 * Mutates and returns the projected items, matching the existing overlay path.
 */
export function placeArpeggioOverlayLabels(items, { width, height }) {
  if (!shouldUseSpatialIndex(items)) return placeWithLinearScan(items, width, height);
  const buckets = new Map();
  const placedRects = [];
  const candidateIds = new Set();
  const scaleRect = { x: 8, y: height - 76, width: width - 16, height: 64 };
  const badgeRect = { x: 8, y: 8, width: 150, height: 54 };

  const overlapsPlaced = (rect) => {
    candidateIds.clear();
    let overlaps = false;
    visitCells(rect, (key) => {
      for (const id of buckets.get(key) ?? []) {
        if (candidateIds.has(id)) continue;
        candidateIds.add(id);
        if (intersects(rect, placedRects[id])) {
          overlaps = true;
          return false;
        }
      }
      return true;
    });
    return overlaps;
  };

  const addPlaced = (rect) => {
    const id = placedRects.push(rect) - 1;
    visitCells(rect, (key) => {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(id);
    });
  };

  for (const item of items) {
    const textWidth = Math.max(16, String(item.label ?? '').length * 5.7 + 5);
    const anchorRight = item.x2 >= item.x1;
    const baseX = anchorRight ? item.x2 + 8 : item.x2 - 8;
    const baseY = item.y2 + 3;
    let chosen = null;
    for (const offset of LABEL_OFFSETS) {
      const x = anchorRight ? baseX : baseX - textWidth;
      const rect = { x, y: baseY + offset - 6, width: textWidth, height: 12 };
      if (rect.x < 6 || rect.x + rect.width > width - 6) continue;
      if (rect.y < 6 || rect.y + rect.height > height - 6) continue;
      if (intersects(rect, scaleRect) || intersects(rect, badgeRect) || overlapsPlaced(rect)) continue;
      chosen = { x, y: baseY + offset, rect };
      break;
    }
    if (!chosen) {
      const x = anchorRight ? baseX : baseX - textWidth;
      chosen = { x, y: baseY, rect: { x, y: baseY - 6, width: textWidth, height: 12 } };
    }
    addPlaced(chosen.rect);
    item.textAnchor = anchorRight ? 'start' : 'end';
    item.labelX = anchorRight ? chosen.x : chosen.x + textWidth;
    item.labelY = chosen.y;
  }
  return items;
}
