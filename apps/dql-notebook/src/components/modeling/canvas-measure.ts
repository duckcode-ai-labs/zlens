import type { Node } from '@xyflow/react';

/**
 * React Flow draws a node only once it has measured it: until then the node is
 * `visibility: hidden` and none of its joins are drawn. A node object without
 * `measured` counts as unmeasured, so a rebuilt node loses its measurement and
 * must wait for a ResizeObserver callback to get it back.
 *
 * The map rebuilds every node object whenever the Modeling page re-renders
 * (each model's details arriving, the drafts banner going away). Right after
 * "Accept all that passed" it re-renders many times in a row, and a rebuild
 * that lands between a ResizeObserver callback and React's next render
 * overwrites the measurement. React Flow then never observes the node again,
 * and the map stays empty until a reload. So a rebuilt node keeps the size
 * React Flow last measured for it; a real size change is still picked up.
 */
export function keepMeasured<T extends Node>(next: T[], current: readonly Node[]): T[] {
  const sizes = new Map<string, NonNullable<Node['measured']>>();
  for (const node of current) {
    if (node.measured?.width && node.measured?.height) sizes.set(node.id, node.measured);
  }
  if (!sizes.size) return next;
  return next.map((node) => {
    const measured = sizes.get(node.id);
    return measured && !node.measured ? { ...node, measured } : node;
  });
}

type MeasuredNode = {
  hidden?: boolean;
  measured?: { width?: number; height?: number };
  internals: { handleBounds?: unknown };
};

/** The shown nodes React Flow has no size or join handles for: hidden on the map, with none of their joins. */
export function unmeasuredNodeIds(nodeLookup: Iterable<[string, MeasuredNode]>): string[] {
  const ids: string[] = [];
  for (const [id, node] of nodeLookup) {
    if (node.hidden) continue;
    if (!node.measured?.width || !node.measured?.height || !node.internals.handleBounds) ids.push(id);
  }
  return ids;
}
