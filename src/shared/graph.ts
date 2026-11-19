export interface GraphSegment {
  /** Lane the segment starts in (at the top of its half-row). */
  from: number;
  /** Lane the segment ends in (at the bottom of its half-row). */
  to: number;
  /** `top` spans row top -> node centre, `bottom` spans node centre -> row bottom. */
  half: 'top' | 'bottom';
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  segments: GraphSegment[];
  /** Number of lanes that need to be drawn for this row. */
  width: number;
}

export interface GraphCommit {
  hash: string;
  parents: string[];
}

/**
 * Assigns each commit (supplied in topological order, newest first) to a lane and
 * produces the line segments needed to draw the commit graph row by row.
 */
export function computeGraph(commits: readonly GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const allocate = (): number => {
    const free = lanes.indexOf(null);
    if (free >= 0) return free;
    lanes.push(null);
    colors.push(0);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const segments: GraphSegment[] = [];
    const widthBefore = lanes.length;

    let lane = -1;
    const converging: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) {
        converging.push(i);
        if (lane < 0) lane = i;
      }
    }
    if (lane < 0) {
      lane = allocate();
      colors[lane] = nextColor++;
    }
    const color = colors[lane];

    for (let i = 0; i < lanes.length; i++) {
      const expected = lanes[i];
      if (expected === null) continue;
      segments.push({ from: i, to: expected === commit.hash ? lane : i, half: 'top', color: colors[i] });
    }

    for (const i of converging) lanes[i] = null;

    const started = new Set<number>([lane]);
    if (commit.parents.length > 0) {
      lanes[lane] = commit.parents[0];
      colors[lane] = color;
      segments.push({ from: lane, to: lane, half: 'bottom', color });

      for (let p = 1; p < commit.parents.length; p++) {
        const parent = commit.parents[p];
        const existing = lanes.indexOf(parent);
        if (existing >= 0) {
          segments.push({ from: lane, to: existing, half: 'bottom', color: colors[existing] });
          continue;
        }
        const target = allocate();
        lanes[target] = parent;
        colors[target] = nextColor++;
        started.add(target);
        segments.push({ from: lane, to: target, half: 'bottom', color: colors[target] });
      }
    }

    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null && !started.has(i)) {
        segments.push({ from: i, to: i, half: 'bottom', color: colors[i] });
      }
    }

    const widthAfter = lanes.length;
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.pop();
    }

    rows.push({ lane, color, segments, width: Math.max(widthBefore, widthAfter, lane + 1) });
  }

  return rows;
}
