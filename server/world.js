// The walk-around restaurant for Map mode. Pure logic, no networking.
//
// The server owns everything: clients only say which way they want to move, the server moves them,
// stops them at walls, and tells each player only what they can see (nearby players with a clear line
// of sight, and the tables in view). Nobody's phone ever receives where the Thief is hiding.

const WORLD = { w: 1600, h: 1000 };
const WALL = 24;
const PLAYER_RADIUS = 14;
const SPEED = 170; // pixels per second
const VISION = 320; // how far you can see, in pixels
const STEAL_RANGE = 85; // how close the Thief must be to a table's bell
const REPORT_RANGE = 95; // how close you must be to an empty stand to report it

// How long a night lasts, and how long before closing the Thief can no longer steal.
// Both can be overridden with environment variables (the tests use short ones).
const NIGHT_SECONDS = Number(process.env.NIGHT_SECONDS) || 180;
const STEAL_LOCKOUT_SECONDS =
  process.env.STEAL_LOCKOUT_SECONDS !== undefined && process.env.STEAL_LOCKOUT_SECONDS !== ''
    ? Number(process.env.STEAL_LOCKOUT_SECONDS)
    : 40;

// ---- The map -------------------------------------------------------------------------------------------

const ZONES = [
  { id: 'kitchen', name: 'Kitchen', x: 24, y: 24, w: 456, h: 396, color: '#3b3a36' },
  { id: 'bar', name: 'Bar', x: 480, y: 24, w: 640, h: 396, color: '#4a3326' },
  { id: 'restrooms', name: 'Restrooms', x: 1120, y: 24, w: 456, h: 396, color: '#2f3d44' },
  { id: 'patio', name: 'Patio', x: 24, y: 420, w: 456, h: 556, color: '#2f4a33' },
  { id: 'dining', name: 'Dining Room', x: 480, y: 420, w: 640, h: 556, color: '#5a3a2a' },
  { id: 'lounge', name: 'Lounge', x: 1120, y: 420, w: 456, h: 556, color: '#3f2f4a' },
];

// A wall along a line, with gaps left open as doorways. Gaps are [from, to] along the wall.
function vWall(x, y1, y2, gaps = []) {
  const out = [];
  let cur = y1;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (a > cur) out.push({ x: x - WALL / 2, y: cur, w: WALL, h: a - cur });
    cur = b;
  }
  if (cur < y2) out.push({ x: x - WALL / 2, y: cur, w: WALL, h: y2 - cur });
  return out;
}

function hWall(y, x1, x2, gaps = []) {
  const out = [];
  let cur = x1;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (a > cur) out.push({ x: cur, y: y - WALL / 2, w: a - cur, h: WALL });
    cur = b;
  }
  if (cur < x2) out.push({ x: cur, y: y - WALL / 2, w: x2 - cur, h: WALL });
  return out;
}

const WALLS = [
  { x: 0, y: 0, w: WORLD.w, h: WALL }, // top
  { x: 0, y: WORLD.h - WALL, w: WORLD.w, h: WALL }, // bottom
  { x: 0, y: 0, w: WALL, h: WORLD.h }, // left
  { x: WORLD.w - WALL, y: 0, w: WALL, h: WORLD.h }, // right
  // Doorways are 100px+ wide so everyone fits through.
  ...vWall(480, 24, 976, [[190, 290], [620, 740]]),
  ...vWall(1120, 24, 976, [[190, 290], [620, 740]]),
  ...hWall(420, 24, 1576, [[190, 310], [720, 880], [1280, 1400]]),
];

const TABLE_SIZE = 90;
// Every table has a bell on a stand at its centre. The Thief steals one of them.
const TABLES = [
  { id: 'T1', name: 'Table 1', x: 640, y: 560 },
  { id: 'T2', name: 'Table 2', x: 960, y: 560 },
  { id: 'T3', name: 'Table 3', x: 640, y: 820 },
  { id: 'T4', name: 'Table 4', x: 960, y: 820 },
  { id: 'P1', name: 'Patio table 1', x: 200, y: 600 },
  { id: 'P2', name: 'Patio table 2', x: 300, y: 830 },
];

// Furniture you can't walk through.
const PROPS = [
  { x: 60, y: 80, w: 240, h: 56, kind: 'counter' },
  { x: 150, y: 220, w: 180, h: 60, kind: 'island' },
  { x: 640, y: 90, w: 320, h: 60, kind: 'bar' },
  { x: 1200, y: 40, w: 90, h: 120, kind: 'stall' },
  { x: 1330, y: 40, w: 90, h: 120, kind: 'stall' },
  { x: 1460, y: 40, w: 90, h: 120, kind: 'stall' },
  { x: 1180, y: 760, w: 180, h: 80, kind: 'couch' },
  { x: 1440, y: 520, w: 100, h: 130, kind: 'couch' },
  { x: 50, y: 450, w: 70, h: 70, kind: 'plant' },
  { x: 380, y: 880, w: 70, h: 70, kind: 'plant' },
];

const TABLE_RECTS = TABLES.map((t) => ({
  x: t.x - TABLE_SIZE / 2,
  y: t.y - TABLE_SIZE / 2,
  w: TABLE_SIZE,
  h: TABLE_SIZE,
  kind: 'table',
}));

const OBSTACLES = [...PROPS, ...TABLE_RECTS];
const SOLIDS = [...WALLS, ...OBSTACLES];

// The part of the map that is safe to send to every client (it never changes).
const PUBLIC_MAP = {
  w: WORLD.w,
  h: WORLD.h,
  zones: ZONES,
  walls: WALLS,
  obstacles: OBSTACLES,
  tables: TABLES.map((t) => ({ ...t, size: TABLE_SIZE })),
  vision: VISION,
  radius: PLAYER_RADIUS,
};

// ---- Geometry ------------------------------------------------------------------------------------------

function circleHitsRect(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

// Would a player standing here be inside a wall or a piece of furniture?
function blockedAt(x, y) {
  for (const rect of SOLIDS) if (circleHitsRect(x, y, PLAYER_RADIUS, rect)) return true;
  return false;
}

// Does the line from (x1,y1) to (x2,y2) pass through the rectangle? (Liang-Barsky clipping.)
function segmentHitsRect(x1, y1, x2, y2, rect) {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const checks = [
    [-dx, x1 - rect.x],
    [dx, rect.x + rect.w - x1],
    [-dy, y1 - rect.y],
    [dy, rect.y + rect.h - y1],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
}

// You see something if it's within vision range and no wall is in the way. Furniture doesn't block sight.
function canSeePoint(ax, ay, bx, by) {
  if (Math.hypot(ax - bx, ay - by) > VISION) return false;
  for (const wall of WALLS) if (segmentHitsRect(ax, ay, bx, by, wall)) return false;
  return true;
}

function zoneAt(x, y) {
  const z = ZONES.find((zone) => x >= zone.x && x < zone.x + zone.w && y >= zone.y && y < zone.y + zone.h);
  return z ? z.name : 'Restaurant';
}

// ---- The world -----------------------------------------------------------------------------------------

function spawnPoint(index) {
  // Everyone starts in a ring in the middle of the dining room.
  const angle = (index / 12) * Math.PI * 2;
  return { x: 800 + Math.cos(angle) * 80, y: 700 + Math.sin(angle) * 80 };
}

function createWorld(playerIds, now = Date.now()) {
  const players = {};
  playerIds.forEach((id, i) => {
    const s = spawnPoint(i);
    players[id] = { x: s.x, y: s.y, face: 0, dx: 0, dy: 0 };
  });
  const endsAt = now + NIGHT_SECONDS * 1000;
  return {
    players,
    bells: Object.fromEntries(TABLES.map((t) => [t.id, true])), // true = the bell is on its stand
    stolenBy: null, // who is carrying the bell
    stolenTable: null, // which table it came from
    stolenAt: null,
    endsAt,
    lockoutAt: endsAt - STEAL_LOCKOUT_SECONDS * 1000,
  };
}

// The client sends a direction. We never trust its size: clamp it to a unit vector at most.
function setInput(world, id, dx, dy) {
  const p = world.players[id];
  if (!p) return;
  let x = Number(dx);
  let y = Number(dy);
  if (!Number.isFinite(x) || !Number.isFinite(y)) x = y = 0;
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  p.dx = x;
  p.dy = y;
}

function step(world, dt) {
  const d = Math.min(Math.max(dt, 0), 0.1); // a slow tick must never let someone jump through a wall
  for (const p of Object.values(world.players)) {
    if (!p.dx && !p.dy) continue;
    const dist = SPEED * d;
    // Move one axis at a time so you slide along walls instead of sticking to them.
    const nx = p.x + p.dx * dist;
    if (!blockedAt(nx, p.y)) p.x = nx;
    const ny = p.y + p.dy * dist;
    if (!blockedAt(p.x, ny)) p.y = ny;
    p.face = Math.atan2(p.dy, p.dx);
  }
}

// What you can do right now, from where you're standing.
function hintsFor(world, id, isThief, now) {
  const me = world.players[id];
  const hint = { steal: null, report: null };
  if (!me) return hint;
  let bestSteal = Infinity;
  let bestReport = Infinity;
  for (const t of TABLES) {
    const d = Math.hypot(me.x - t.x, me.y - t.y);
    if (world.bells[t.id]) {
      const canSteal = isThief && !world.stolenTable && now < world.lockoutAt && d <= STEAL_RANGE;
      if (canSteal && d < bestSteal) {
        bestSteal = d;
        hint.steal = t.id;
      }
    } else if (d <= REPORT_RANGE && d < bestReport) {
      bestReport = d;
      hint.report = t.id;
    }
  }
  return hint;
}

function steal(world, id, isThief, now = Date.now()) {
  if (!isThief) return { error: 'Only the Thief can steal the bell.' };
  if (world.stolenTable) return { error: 'You already have the bell.' };
  if (now >= world.lockoutAt) return { error: "Too late. The restaurant is about to close." };
  const { steal: tableId } = hintsFor(world, id, true, now);
  if (!tableId) return { error: 'Get closer to a bell first.' };
  world.bells[tableId] = false;
  world.stolenBy = id;
  world.stolenTable = tableId;
  world.stolenAt = now;
  return { ok: true, table: tableId };
}

function report(world, id, now = Date.now()) {
  const { report: tableId } = hintsFor(world, id, false, now);
  if (!tableId) return { error: 'Nothing is missing here.' };
  return { ok: true, table: tableId };
}

// Everything one player is allowed to know about the world right now.
function snapshotFor(world, id, isThief, now = Date.now()) {
  const me = world.players[id];
  if (!me) return null;
  const round1 = (n) => Math.round(n * 10) / 10;
  const others = [];
  for (const [otherId, p] of Object.entries(world.players)) {
    if (otherId === id) continue;
    if (canSeePoint(me.x, me.y, p.x, p.y)) {
      others.push({ id: otherId, x: round1(p.x), y: round1(p.y), face: round1(p.face), moving: !!(p.dx || p.dy) });
    }
  }
  // You only learn the state of a bell stand when you can see it.
  const bells = {};
  for (const t of TABLES) if (canSeePoint(me.x, me.y, t.x, t.y)) bells[t.id] = !!world.bells[t.id];
  return {
    me: { x: round1(me.x), y: round1(me.y), face: round1(me.face) },
    others,
    bells,
    where: zoneAt(me.x, me.y),
    hint: hintsFor(world, id, isThief, now),
    carrying: !!isThief && world.stolenBy === id,
    endsAt: world.endsAt,
  };
}

module.exports = {
  WORLD,
  PLAYER_RADIUS,
  SPEED,
  VISION,
  STEAL_RANGE,
  REPORT_RANGE,
  NIGHT_SECONDS,
  ZONES,
  TABLES,
  WALLS,
  SOLIDS,
  PUBLIC_MAP,
  createWorld,
  setInput,
  step,
  steal,
  report,
  snapshotFor,
  hintsFor,
  blockedAt,
  canSeePoint,
  segmentHitsRect,
  zoneAt,
  spawnPoint,
};
