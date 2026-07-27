import type { WhiteboardBounds } from "./geometry";

export const OWNED_SPATIAL_CELL_SIZE = 512;
export const OWNED_SPATIAL_MAX_CELLS = 64;

interface SpatialEntry {
  readonly bounds: WhiteboardBounds;
  readonly cells: readonly string[];
  readonly oversized: boolean;
}

/**
 * Uniform broad-phase index shared by rendering and interaction queries.
 */
export class OwnedSpatialIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly entries = new Map<string, SpatialEntry>();
  private readonly oversized = new Set<string>();

  public insert(id: string, bounds: WhiteboardBounds): void {
    this.delete(id);
    const cells = cellsForBounds(bounds);
    const oversized = cells.length > OWNED_SPATIAL_MAX_CELLS;
    this.entries.set(id, {
      bounds,
      cells: oversized ? [] : cells,
      oversized,
    });
    if (oversized) {
      this.oversized.add(id);
      return;
    }
    for (const cell of cells) {
      const ids = this.cells.get(cell) ?? new Set<string>();
      ids.add(id);
      this.cells.set(cell, ids);
    }
  }

  public update(id: string, bounds: WhiteboardBounds): void {
    const current = this.entries.get(id);
    if (current && sameBounds(current.bounds, bounds)) return;
    this.insert(id, bounds);
  }

  public delete(id: string): void {
    const current = this.entries.get(id);
    if (!current) return;
    this.entries.delete(id);
    this.oversized.delete(id);
    for (const cell of current.cells) {
      const ids = this.cells.get(cell);
      if (!ids) continue;
      ids.delete(id);
      if (ids.size === 0) this.cells.delete(cell);
    }
  }

  public query(bounds: WhiteboardBounds): ReadonlySet<string> {
    const result = new Set<string>();
    for (const cell of cellsForBounds(bounds)) {
      const ids = this.cells.get(cell);
      if (!ids) continue;
      for (const id of ids) {
        const entry = this.entries.get(id);
        if (entry && intersects(entry.bounds, bounds)) result.add(id);
      }
    }
    for (const id of this.oversized) {
      const entry = this.entries.get(id);
      if (entry && intersects(entry.bounds, bounds)) result.add(id);
    }
    return result;
  }

  public clear(): void {
    this.cells.clear();
    this.entries.clear();
    this.oversized.clear();
  }

  public getDiagnostics(): {
    readonly cells: number;
    readonly elements: number;
    readonly oversizedElements: number;
  } {
    return {
      cells: this.cells.size,
      elements: this.entries.size,
      oversizedElements: this.oversized.size,
    };
  }
}

function cellsForBounds(bounds: WhiteboardBounds): readonly string[] {
  const minCellX = Math.floor(bounds.minX / OWNED_SPATIAL_CELL_SIZE);
  const minCellY = Math.floor(bounds.minY / OWNED_SPATIAL_CELL_SIZE);
  const maxCellX = Math.floor(bounds.maxX / OWNED_SPATIAL_CELL_SIZE);
  const maxCellY = Math.floor(bounds.maxY / OWNED_SPATIAL_CELL_SIZE);
  const width = maxCellX - minCellX + 1;
  const height = maxCellY - minCellY + 1;
  if (width * height > OWNED_SPATIAL_MAX_CELLS) {
    return Array.from(
      { length: OWNED_SPATIAL_MAX_CELLS + 1 },
      (_, index) => `oversized:${index}`,
    );
  }
  const cells: string[] = [];
  for (let x = minCellX; x <= maxCellX; x += 1) {
    for (let y = minCellY; y <= maxCellY; y += 1) {
      cells.push(`${x}:${y}`);
    }
  }
  return cells;
}

function sameBounds(left: WhiteboardBounds, right: WhiteboardBounds): boolean {
  return (
    left.minX === right.minX &&
    left.minY === right.minY &&
    left.maxX === right.maxX &&
    left.maxY === right.maxY
  );
}

function intersects(left: WhiteboardBounds, right: WhiteboardBounds): boolean {
  return !(
    left.maxX < right.minX ||
    left.minX > right.maxX ||
    left.maxY < right.minY ||
    left.minY > right.maxY
  );
}
