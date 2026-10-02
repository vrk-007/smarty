import type { ComponentInstance, PinDef, Rotation } from "../types/circuit";

/** Size, in screen pixels, of one grid unit. Every coordinate stored in
 *  the document is in grid units; this is the only place px-per-unit lives. */
export const GRID_SIZE = 24;

export function snap(value: number): number {
  return Math.round(value);
}

export function gridToPx(value: number): number {
  return value * GRID_SIZE;
}

export function pxToGrid(value: number): number {
  return value / GRID_SIZE;
}

/** Rotate a local point by a component's rotation, then apply mirroring
 *  (mirror flips the local X axis before rotation, matching how most
 *  schematic tools define "flip horizontal"). Returns local-space point. */
export function transformLocal(
  local: { x: number; y: number },
  rotation: Rotation,
  mirrored: boolean
): { x: number; y: number } {
  let { x, y } = local;
  if (mirrored) x = -x;

  const rad = (rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
  };
}

/** Resolve a pin's absolute position (grid units) for a placed component. */
export function resolvePinWorld(
  component: ComponentInstance,
  pin: PinDef
): { x: number; y: number } {
  const t = transformLocal(pin.local, component.rotation, component.mirrored);
  return { x: component.x + t.x, y: component.y + t.y };
}

export function distance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Unit direction a pin points out of its component (e.g. {0,-1} for the
 *  top pin of a vertical part), used to route wires away from the body. */
export function pinDirection(
  component: ComponentInstance,
  pin: PinDef
): { x: number; y: number } {
  const t = transformLocal(pin.local, component.rotation, component.mirrored);
  return { x: Math.sign(t.x), y: Math.sign(t.y) };
}

type Pt = { x: number; y: number };

/** Grid units a wire runs straight out of a pin before it may turn. */
const PIN_STUB = 1;

/** Build an orthogonal (Manhattan) path between two points. When the pins'
 *  outward directions are known the wire must leave each pin along that
 *  direction, never back across the part's body: the plain L / Z shapes
 *  are used when they satisfy that, otherwise the wire steps out of each
 *  pin by PIN_STUB and is routed between the stubs. Without directions it
 *  leaves horizontally first, which reads well for left/right parts. */
export function orthogonalPath(a: Pt, b: Pt, dirA?: Pt, dirB?: Pt): Pt[] {
  if (!dirA && !dirB) {
    if (a.x === b.x || a.y === b.y) return [a, b];
    const midX = (a.x + b.x) / 2;
    return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
  }

  const candidates: Pt[][] = [[a, b]];
  candidates.push([a, { x: a.x, y: b.y }, b], [a, { x: b.x, y: a.y }, b]);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  candidates.push(
    [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b],
    [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b]
  );
  // Both pins facing the same way: run the shared leg past the outer pin.
  if (dirA && dirB && dirA.x === dirB.x && dirA.y === dirB.y) {
    if (dirA.y !== 0) {
      const y = dirA.y > 0 ? Math.max(a.y, b.y) + PIN_STUB : Math.min(a.y, b.y) - PIN_STUB;
      candidates.push([a, { x: a.x, y }, { x: b.x, y }, b]);
    } else {
      const x = dirA.x > 0 ? Math.max(a.x, b.x) + PIN_STUB : Math.min(a.x, b.x) - PIN_STUB;
      candidates.push([a, { x, y: a.y }, { x, y: b.y }, b]);
    }
  }
  // Fallback: step out of both pins, then join the stubs.
  const sa = dirA ? { x: a.x + dirA.x * PIN_STUB, y: a.y + dirA.y * PIN_STUB } : a;
  const sb = dirB ? { x: b.x + dirB.x * PIN_STUB, y: b.y + dirB.y * PIN_STUB } : b;
  candidates.push(
    [a, sa, { x: sa.x, y: sb.y }, sb, b],
    [a, sa, { x: sb.x, y: sa.y }, sb, b],
    [a, sa, { x: (sa.x + sb.x) / 2, y: sa.y }, { x: (sa.x + sb.x) / 2, y: sb.y }, sb, b],
    [a, sa, { x: sa.x, y: (sa.y + sb.y) / 2 }, { x: sb.x, y: (sa.y + sb.y) / 2 }, sb, b]
  );

  for (const path of candidates) {
    const clean = simplify(path);
    if (isOrthogonal(clean) && leaves(clean, dirA) && leaves([...clean].reverse(), dirB)) {
      return clean;
    }
  }
  return simplify(candidates[candidates.length - 1]);
}

/** Path for a wire the user has dragged: step out of each pin, then cross
 *  on the chosen line (a horizontal run at y = value, or a vertical run at
 *  x = value). */
export function routedPath(
  a: Pt,
  b: Pt,
  dirA: Pt | undefined,
  dirB: Pt | undefined,
  route: { axis: "x" | "y"; value: number }
): Pt[] {
  const sa = dirA ? { x: a.x + dirA.x * PIN_STUB, y: a.y + dirA.y * PIN_STUB } : a;
  const sb = dirB ? { x: b.x + dirB.x * PIN_STUB, y: b.y + dirB.y * PIN_STUB } : b;
  // Skip a stub that would point away from the run and fold back on itself.
  const startA = towards(a, sa, route) ? sa : a;
  const startB = towards(b, sb, route) ? sb : b;
  const v = route.value;
  const mid =
    route.axis === "y"
      ? [{ x: startA.x, y: v }, { x: startB.x, y: v }]
      : [{ x: v, y: startA.y }, { x: v, y: startB.y }];
  return simplify([a, startA, ...mid, startB, b]);
}

function towards(p: Pt, stub: Pt, route: { axis: "x" | "y"; value: number }): boolean {
  if (route.axis === "y") return stub.y === p.y || Math.sign(stub.y - p.y) === Math.sign(route.value - p.y);
  return stub.x === p.x || Math.sign(stub.x - p.x) === Math.sign(route.value - p.x);
}

/** Drop repeated points and merge collinear runs. */
function simplify(path: Pt[]): Pt[] {
  const pts = path.filter((p, i) => i === 0 || p.x !== path[i - 1].x || p.y !== path[i - 1].y);
  return pts.filter((p, i) => {
    if (i === 0 || i === pts.length - 1) return true;
    const prev = pts[i - 1];
    const next = pts[i + 1];
    return !((prev.x === p.x && p.x === next.x) || (prev.y === p.y && p.y === next.y));
  });
}

function isOrthogonal(path: Pt[]): boolean {
  return path.every((p, i) => i === 0 || p.x === path[i - 1].x || p.y === path[i - 1].y);
}

/** True if the path's first segment heads out along `dir` (any if unknown). */
function leaves(path: Pt[], dir?: Pt): boolean {
  if (!dir || path.length < 2) return true;
  const dx = Math.sign(path[1].x - path[0].x);
  const dy = Math.sign(path[1].y - path[0].y);
  return dx === dir.x && dy === dir.y;
}
