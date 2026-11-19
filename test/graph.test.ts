import { describe, expect, it } from 'vitest';
import { computeGraph } from '../src/shared/graph';

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe('computeGraph', () => {
  it('keeps a linear history in a single lane', () => {
    const rows = computeGraph([c('c', 'b'), c('b', 'a'), c('a')]);
    expect(rows.map(r => r.lane)).toEqual([0, 0, 0]);
    expect(rows.every(r => r.width === 1)).toBe(true);
    expect(rows[0].segments).toEqual([{ from: 0, to: 0, half: 'bottom', color: 0 }]);
    expect(rows[2].segments).toEqual([{ from: 0, to: 0, half: 'top', color: 0 }]);
  });

  it('opens a lane for a merge parent and closes it where the branch forks', () => {
    //  m       merge of f into x
    //  | f
    //  x |
    //  |/
    //  base
    const rows = computeGraph([c('m', 'x', 'f'), c('f', 'base'), c('x', 'base'), c('base')]);
    expect(rows.map(r => r.lane)).toEqual([0, 1, 0, 0]);
    expect(rows[0].segments).toContainEqual({ from: 0, to: 1, half: 'bottom', color: 1 });
    // base row: lane 1 converges into lane 0
    expect(rows[3].segments).toContainEqual({ from: 1, to: 0, half: 'top', color: 1 });
    expect(rows[3].width).toBe(2);
  });

  it('starts new lanes for unrelated branch heads and passes other lanes through', () => {
    const rows = computeGraph([c('a2', 'a1'), c('b1', 'a1'), c('a1')]);
    expect(rows[1].lane).toBe(1);
    expect(rows[1].segments).toContainEqual({ from: 0, to: 0, half: 'top', color: 0 });
    expect(rows[1].segments).toContainEqual({ from: 0, to: 0, half: 'bottom', color: 0 });
    expect(rows[2].segments.filter(s => s.half === 'top').map(s => [s.from, s.to])).toEqual([[0, 0], [1, 0]]);
  });

  it('links a merge to a parent already tracked by another lane', () => {
    const rows = computeGraph([c('x', 'p'), c('m', 'q', 'p'), c('q', 'p'), c('p')]);
    expect(rows[1].lane).toBe(1);
    expect(rows[1].segments).toContainEqual({ from: 1, to: 0, half: 'bottom', color: 0 });
  });

  it('reuses freed lanes', () => {
    const rows = computeGraph([c('m', 'a', 'b'), c('b', 'r'), c('a', 'r'), c('r'), c('z')]);
    expect(rows[4].lane).toBe(0);
  });
});
