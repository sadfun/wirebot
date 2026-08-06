/** Evict the oldest entries (insertion order) until the set fits the limit. */
export function trimInsertionOrdered(set: Set<string>, limit: number): void {
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) return;
    set.delete(oldest);
  }
}

/** Evict the oldest entries (insertion order) until the map fits the limit. */
export function trimInsertionOrderedMap(map: Map<string, string>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
