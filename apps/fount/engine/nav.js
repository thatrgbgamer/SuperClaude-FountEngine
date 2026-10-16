// Navigation, baked from the level's own brushes. There is no separate navmesh
// to author: at load the walkable ground is sampled on a grid by tracing down
// through the same collision world players and projectiles use, so what an
// actor thinks it can walk on and what it actually collides with cannot drift
// apart.
//
// One height per cell, so the grid describes a single walkable layer under the
// "top" height. Roofs and ceilings above `top` are ignored, which is what lets
// a building with a roof still have a walkable floor. Multi-storey interiors
// would need `top` per region; that is out of scope here.

const SQRT2 = Math.SQRT2;

class MinHeap {
  constructor() { this.keys = []; this.values = []; }
  get size() { return this.keys.length; }
  push(key, value) {
    const k = this.keys, v = this.values;
    let i = k.length;
    k.push(key); v.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.keys, v = this.values;
    const top = v[0];
    const lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      k[0] = lastK; v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

export class NavGrid {
  /**
   * options: { cell, top, bottom, halfExtents, stepHeight, bounds }
   * `top` is the highest a walker's head could be: the sampling ray starts there.
   */
  static build(collision, options = {}) {
    return new NavGrid(collision, options);
  }

  constructor(collision, options = {}) {
    this.collision = collision;
    const b = options.bounds || collision.bounds;
    this.minX = b.min[0];
    this.minZ = b.min[2];
    let cell = options.cell ?? 0.5;
    let w = Math.max(1, Math.ceil((b.max[0] - b.min[0]) / cell));
    let h = Math.max(1, Math.ceil((b.max[2] - b.min[2]) / cell));
    // A huge map at a fine cell size would cost seconds and megabytes; coarsen it.
    const cap = options.maxCells ?? 250000;
    if (w * h > cap) {
      const k = Math.sqrt((w * h) / cap);
      cell *= k;
      w = Math.max(1, Math.ceil((b.max[0] - b.min[0]) / cell));
      h = Math.max(1, Math.ceil((b.max[2] - b.min[2]) / cell));
      console.warn(`[fount] nav grid coarsened to ${cell.toFixed(2)}m cells (${w}x${h}) to stay under ${cap} cells`);
    }
    this.cell = cell;
    this.w = w;
    this.h = h;
    this.half = options.halfExtents || [0.3, 0.9, 0.3];
    this.stepHeight = options.stepHeight ?? 0.55;
    this.minRegion = options.minRegion ?? 80;   // smaller disconnected patches are dropped as unreachable islands
    this.top = options.top ?? b.min[1] + 6;
    this.bottom = options.bottom ?? b.min[1] - 2;

    this.height = new Float32Array(w * h).fill(NaN);
    this.near = new Uint8Array(w * h); // 1 if a blocked cell touches this one: paths prefer to keep clear
    this.bake();

    this.stamp = new Uint32Array(w * h);
    this.gScore = new Float32Array(w * h);
    this.parent = new Int32Array(w * h);
    this.generation = 0;
  }

  bake() {
    const { w, h, cell } = this;
    const col = this.collision;
    let walkable = 0;
    for (let cz = 0; cz < h; cz++) {
      for (let cx = 0; cx < w; cx++) {
        const x = this.minX + (cx + 0.5) * cell;
        const z = this.minZ + (cz + 0.5) * cell;
        const tr = col.traceRay([x, this.top, z], [x, this.bottom, z]);
        if (!tr.hit || tr.startSolid || tr.normal[1] < 0.7) continue;
        const y = tr.endPos[1];
        // Would a walker fit standing here? The box starts a little above the
        // ground, otherwise a ramp's rising surface clips its leading edge and
        // every slope reads as blocked. Anything taller than that lift still blocks.
        const lift = 0.4;
        if (col.pointInSolid([x, y + this.half[1] + lift / 2, z], [this.half[0], this.half[1] - lift / 2, this.half[2]])) continue;
        this.height[cz * w + cx] = y;
        walkable++;
      }
    }
    for (let cz = 0; cz < h; cz++) {
      for (let cx = 0; cx < w; cx++) {
        const i = cz * w + cx;
        if (Number.isNaN(this.height[i])) continue;
        if (!this.ok(cx - 1, cz) || !this.ok(cx + 1, cz) || !this.ok(cx, cz - 1) || !this.ok(cx, cz + 1)) this.near[i] = 1;
      }
    }
    this.walkableCount = walkable;
    this.pruneIslands(this.minRegion);
  }

  /**
   * The top of a wall or crate is a walkable surface under `top`, but nobody can
   * get there. Drop small disconnected patches so wander targets and "nearest
   * walkable" never land on one. The largest region always survives.
   */
  pruneIslands(minCells) {
    const { w, h } = this;
    const label = new Int32Array(w * h).fill(-1);
    const regions = [];
    for (let start = 0; start < w * h; start++) {
      if (Number.isNaN(this.height[start]) || label[start] !== -1) continue;
      const id = regions.length;
      const members = [start];
      label[start] = id;
      for (let head = 0; head < members.length; head++) {
        const cur = members[head];
        const cx = cur % w, cz = (cur - cx) / w;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if ((!dx && !dz) || !this.connected(cx, cz, cx + dx, cz + dz)) continue;
            const ni = (cz + dz) * w + cx + dx;
            if (label[ni] === -1) { label[ni] = id; members.push(ni); }
          }
        }
      }
      regions.push(members);
    }
    if (regions.length <= 1) return;
    const largest = regions.reduce((a, b) => (b.length > a.length ? b : a));
    for (const members of regions) {
      if (members === largest || members.length >= minCells) continue;
      for (const i of members) { this.height[i] = NaN; this.walkableCount--; }
    }
    // Cells beside a pruned region are now next to a "wall" for path costs.
    for (let i = 0; i < w * h; i++) {
      if (Number.isNaN(this.height[i])) continue;
      const cx = i % w, cz = (i - cx) / w;
      this.near[i] = (!this.ok(cx - 1, cz) || !this.ok(cx + 1, cz) || !this.ok(cx, cz - 1) || !this.ok(cx, cz + 1)) ? 1 : 0;
    }
  }

  ok(cx, cz) {
    return cx >= 0 && cz >= 0 && cx < this.w && cz < this.h && !Number.isNaN(this.height[cz * this.w + cx]);
  }

  toCell(x, z) {
    return [Math.floor((x - this.minX) / this.cell), Math.floor((z - this.minZ) / this.cell)];
  }

  toWorld(cx, cz) {
    return [this.minX + (cx + 0.5) * this.cell, this.height[cz * this.w + cx], this.minZ + (cz + 0.5) * this.cell];
  }

  /** Is the ground at this world position walkable? */
  isWalkable(x, z) {
    const [cx, cz] = this.toCell(x, z);
    return this.ok(cx, cz);
  }

  /** The closest walkable cell to a world position, searched in widening rings. */
  nearestWalkable(x, z, maxRings = 12) {
    const [cx, cz] = this.toCell(x, z);
    if (this.ok(cx, cz)) return [cx, cz];
    for (let r = 1; r <= maxRings; r++) {
      let best = null, bestD = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r || !this.ok(cx + dx, cz + dz)) continue;
          const wx = this.minX + (cx + dx + 0.5) * this.cell - x, wz = this.minZ + (cz + dz + 0.5) * this.cell - z;
          const d = wx * wx + wz * wz;
          if (d < bestD) { bestD = d; best = [cx + dx, cz + dz]; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Can a walker step between two adjacent cells? */
  connected(ax, az, bx, bz) {
    if (!this.ok(ax, az) || !this.ok(bx, bz)) return false;
    const diagonal = ax !== bx && az !== bz;
    const limit = Math.max(this.stepHeight, this.cell * 1.05) * (diagonal ? 1.42 : 1);
    if (Math.abs(this.height[az * this.w + ax] - this.height[bz * this.w + bx]) > limit) return false;
    if (diagonal) {
      // No cutting corners: both cells either side of the diagonal must be open too.
      return this.connected(ax, az, bx, az) && this.connected(ax, az, ax, bz);
    }
    return true;
  }

  /**
   * A* from one world position to another. Returns waypoints [[x, y, z], ...] or
   * null if the start and goal are not connected. If the goal cannot be reached,
   * returns the path to the reachable cell nearest it (so a chasing monster still
   * closes in on a player standing across a wall) unless options.exact is set.
   */
  findPath(from, to, options = {}) {
    const start = this.nearestWalkable(from[0], from[2]);
    const goal = this.nearestWalkable(to[0], to[2]);
    if (!start || !goal) return null;

    const { w } = this;
    const gen = ++this.generation;
    const startI = start[1] * w + start[0];
    const goalI = goal[1] * w + goal[0];
    const open = new MinHeap();
    this.stamp[startI] = gen;
    this.gScore[startI] = 0;
    this.parent[startI] = -1;
    open.push(0, startI);

    const maxExpand = options.maxExpand ?? 6000;
    let expanded = 0;
    let best = startI, bestH = Infinity;
    const heuristic = (cx, cz) => {
      const dx = Math.abs(cx - goal[0]), dz = Math.abs(cz - goal[1]);
      return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz);
    };
    const closed = new Set();

    while (open.size && expanded < maxExpand) {
      const cur = open.pop();
      if (closed.has(cur)) continue;
      closed.add(cur);
      expanded++;
      if (cur === goalI) { best = cur; break; }
      const cx = cur % w, cz = (cur - cx) / w;
      const hh = heuristic(cx, cz);
      if (hh < bestH) { bestH = hh; best = cur; }

      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = cx + dx, nz = cz + dz;
          if (!this.connected(cx, cz, nx, nz)) continue;
          const ni = nz * w + nx;
          if (closed.has(ni)) continue;
          const step = (dx && dz ? SQRT2 : 1) + (this.near[ni] ? 0.6 : 0);
          const g = this.gScore[cur] + step;
          if (this.stamp[ni] !== gen || g < this.gScore[ni]) {
            this.stamp[ni] = gen;
            this.gScore[ni] = g;
            this.parent[ni] = cur;
            open.push(g + heuristic(nx, nz), ni);
          }
        }
      }
    }

    if (best !== goalI && options.exact) return null;

    const cells = [];
    for (let i = best; i !== -1; i = this.parent[i]) cells.push(i);
    cells.reverse();
    let path = cells.map((i) => { const cx = i % w; return this.toWorld(cx, (i - cx) / w); });
    // Land exactly on the requested point if its own cell was the goal.
    if (best === goalI && this.ok(...this.toCell(to[0], to[2]))) {
      path[path.length - 1] = [to[0], path[path.length - 1][1], to[2]];
    }
    if (options.smooth !== false) path = this.smooth(path);
    // The first waypoint is where we already are.
    if (path.length > 1) path.shift();
    return path;
  }

  /** Is the straight line between two world points all walkable, without big height jumps? */
  lineClear(a, b) {
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
    let prevY = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const [cx, cz] = this.toCell(a[0] + dx * t, a[2] + dz * t);
      if (!this.ok(cx, cz)) return false;
      const y = this.height[cz * this.w + cx];
      if (prevY !== null && Math.abs(y - prevY) > this.stepHeight) return false;
      prevY = y;
      // Paths hugging a corner cut through blocked neighbours; require the cells either side to be open too.
      const px = -dz / (len || 1), pz = dx / (len || 1);
      const side = this.cell * 0.6;
      for (const s of [-1, 1]) {
        const [sx, sz] = this.toCell(a[0] + dx * t + px * side * s, a[2] + dz * t + pz * side * s);
        if (!this.ok(sx, sz)) return false;
      }
    }
    return true;
  }

  /** String-pulling: drop every waypoint that the one before it can already see past. */
  smooth(path) {
    if (path.length <= 2) return path;
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = path.length - 1;
      while (j > i + 1 && !this.lineClear(path[i], path[j])) j--;
      out.push(path[j]);
      i = j;
    }
    return out;
  }
}
