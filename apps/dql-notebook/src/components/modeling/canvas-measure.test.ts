import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { keepMeasured, unmeasuredNodeIds } from './canvas-measure';

const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, position: { x: 0, y: 0 }, data: {}, ...extra });

describe('keepMeasured', () => {
  it('keeps the size React Flow measured when the map rebuilds its nodes', () => {
    const current = [node('player', { measured: { width: 280, height: 116 } }), node('team', { measured: { width: 300, height: 116 } })];
    const next = [node('player', { position: { x: 40, y: 10 }, data: { label: 'new' } }), node('team')];
    const kept = keepMeasured(next, current);
    expect(kept.map((item) => item.measured)).toEqual([{ width: 280, height: 116 }, { width: 300, height: 116 }]);
    // Everything else comes from the rebuilt node.
    expect(kept[0]).toMatchObject({ position: { x: 40, y: 10 }, data: { label: 'new' } });
    // The rebuilt nodes are not changed in place.
    expect(next[0]!.measured).toBeUndefined();
  });

  it('leaves new and never-measured nodes for React Flow to measure', () => {
    const current = [node('player', { measured: { width: 280, height: 116 } }), node('game')];
    const kept = keepMeasured([node('player'), node('game'), node('season')], current);
    expect(kept.map((item) => item.measured)).toEqual([{ width: 280, height: 116 }, undefined, undefined]);
  });

  it('does not replace a size the rebuilt node already has', () => {
    const kept = keepMeasured([node('player', { measured: { width: 320, height: 145 } })], [node('player', { measured: { width: 280, height: 116 } })]);
    expect(kept[0]!.measured).toEqual({ width: 320, height: 145 });
  });

  it('returns the rebuilt nodes as they are before anything was measured', () => {
    const next = [node('player'), node('team')];
    expect(keepMeasured(next, [node('player'), node('team')])).toBe(next);
  });
});

describe('unmeasuredNodeIds', () => {
  it('lists the shown nodes without a size or join handles', () => {
    const lookup = new Map([
      ['measured', { measured: { width: 280, height: 116 }, internals: { handleBounds: { source: [], target: [] } } }],
      ['no-size', { measured: { width: undefined, height: undefined }, internals: {} }],
      ['no-handles', { measured: { width: 280, height: 116 }, internals: {} }],
      ['hidden', { hidden: true, measured: {}, internals: {} }],
    ]);
    expect(unmeasuredNodeIds(lookup)).toEqual(['no-size', 'no-handles']);
  });
});
