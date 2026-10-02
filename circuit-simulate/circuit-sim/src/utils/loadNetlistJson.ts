/**
 * Parses the external JSON netlist format and converts it into the internal
 * ComponentInstance[] + Wire[] representation for the schematic canvas.
 *
 * Coordinate methodology (mirrors CircuitJS grid-snap approach):
 *   1. Collect all pin pixel coordinates from component_details.
 *   2. Cluster nearby X and Y values within a 50 px tolerance → unified values,
 *      ensuring components on the same rail align perfectly.
 *   3. Build a pixel→grid transform from the clustered extents.
 *   4. Snap each grid value to the nearest integer (equivalent to
 *      round(coord / (S × GRID_STEP)) × GRID_STEP in CircuitJS terms).
 *   5. Reconstruct wire topology directly from pin net_id fields — avoids
 *      fragmented/disjointed raw segment geometry.
 *
 * Supports two flavours of the format:
 *
 * ── NEW (rich) format ────────────────────────────────────────────────────────
 * Includes `component_details` (pixel bboxes + pin pixel coords) and
 * optionally `wires.segments` / `wires.junctions`.
 * Wire routing: net_id on each pin → group → chain → Wire[].  Falls back to
 * segment union-find, then net-array inference.
 *
 * ── OLD (simple) format ──────────────────────────────────────────────────────
 * Only has `components` + `nets`.
 * Layout  : auto-grid (4-column).
 * Wiring  : chain pins that share the same net.
 */

import { v4 as uuid } from "uuid";
import type { ComponentInstance, ComponentKind, Rotation, Wire, PinRef } from "../types/circuit";
import { getDef } from "../domain/componentDefs";
import { snap, orthogonalPath, pinDirection, resolvePinWorld } from "./geometry";

// ─── External JSON types ──────────────────────────────────────────────────────

export interface JsonNet {
  id: string;
  pins: string[]; // e.g. ["R1.A", "V1.+"]
}

export interface JsonComponent {
  ref_des: string;
  type: string;
  value: string;
  net_pos: string;
  net_neg: string;
  spice_line: string;
}

export interface JsonWireSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface JsonWires {
  segments: JsonWireSegment[];
  junctions?: { x: number; y: number }[];
  endpoints?: { x: number; y: number }[];
}

export interface JsonPinDetail {
  name: string;
  x: number; // pixel position in original image
  y: number;
  net_id?: string;
}

export interface JsonComponentDetail {
  ref_des: string;
  type: string;
  bbox: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    cx: number; // centre pixel X
    cy: number; // centre pixel Y
  };
  conf: number;
  pins: JsonPinDetail[];
}

/** Grid / scale metadata emitted by the v2 backend pipeline. */
export interface JsonGrid {
  /** CircuitJS grid snap size in pixels (always 16). */
  circuitjs_grid: number;
  /** pixels → CircuitJS units: cjsX = pin.x * scale_x */
  scale_x: number;
  /** pixels → CircuitJS units: cjsY = pin.y * scale_y */
  scale_y: number;
}

export interface JsonNetlist {
  title?: string;
  timestamp?: string;
  image?: { width: number; height: number };
  /** v2 backend: pre-computed scale factors for CircuitJS coordinate mapping. */
  grid?: JsonGrid;
  /** v1 backend only: raw wire pixel segments (removed in v2). */
  wires?: JsonWires;
  nets?: JsonNet[];
  components: JsonComponent[];
  component_details?: JsonComponentDetail[];
}

// ─── Load result ──────────────────────────────────────────────────────────────

/** A wire segment already converted to grid-unit space, ready for SVG rendering. */
export interface RawWireSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A junction dot in grid-unit space. */
export interface RawJunction {
  x: number;
  y: number;
}

export interface LoadResult {
  components: ComponentInstance[];
  wires: Wire[];
  skipped: string[]; // ref_des of unsupported component types
  /** Raw wire segments scaled to grid units (mirrors wires.segments from JSON). */
  rawWireSegments: RawWireSegment[];
  /** Junction dots scaled to grid units (mirrors wires.junctions from JSON). */
  rawJunctions: RawJunction[];
}

// ─── Type mapping ─────────────────────────────────────────────────────────────

function typeToKind(type: string): ComponentKind | null {
  switch (type.toLowerCase().trim()) {
    case "resistor":    return "resistor";
    case "capacitor":   return "capacitor";
    case "inductor":    return "inductor";
    case "battery":     return "battery";
    case "diode":       return "diode";
    case "dep. voltage":
    case "dep voltage":
    case "dependent voltage":
    case "vsource_dep": return "vsource_dep";
    case "voltage":
    case "vsource":
    case "vsource_dc":
    case "dc voltage":
    case "dc":          return "vsource_dc";
    case "ac source":
    case "vsource_ac":
    case "ac voltage":
    case "ac":          return "vsource_ac";
    case "ground":
    case "gnd":         return "ground";
    default:            return null; // transistors etc. not yet in canvas
  }
}

// ─── Bridge nets across unsupported (skipped) components ─────────────────────

/**
 * The canvas doesn't yet draw every component kind the backend detects (e.g.
 * Diode, transistors). Simply omitting an unsupported part leaves its two
 * terminal nets unconnected — the loop it used to close now dead-ends, so the
 * rendered circuit looks broken/open even though the source photo shows a
 * closed loop.
 *
 * This treats every skipped 2-terminal component as a short: it unions its
 * net_pos/net_neg into one net *before* any layout/wiring logic runs, so the
 * rest of the pipeline (chain tracing, pin-net_id wire building) sees a
 * single continuous net straight through where the unsupported part sat —
 * closing the loop exactly as it is in the photo.
 */
function unionNets(json: JsonNetlist): Map<string, string> {
  const parent = new Map<string, string>();
  function find(x: string): string {
    let root = x;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    if (!parent.has(root)) parent.set(root, root);
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur) ?? cur;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const jc of json.components) {
    if (typeToKind(jc.type)) continue; // supported — draws its own symbol, no bridging needed
    // "?" marks a net the backend couldn't resolve; never bridge those together.
    if (!jc.net_pos || !jc.net_neg || jc.net_pos === "?" || jc.net_neg === "?") continue;
    if (jc.net_pos === jc.net_neg) continue;
    union(jc.net_pos, jc.net_neg);
  }

  const canonical = new Map<string, string>();
  for (const key of parent.keys()) canonical.set(key, find(key));
  return canonical;
}

function remapNetId(canonical: Map<string, string>, id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  return canonical.get(id) ?? id;
}

/** Apply {@link unionNets}' merged net ids across the whole netlist so every
 *  downstream consumer (chain tracing, wire builders) sees the bridged nets. */
function bridgeSkippedComponentNets(json: JsonNetlist): JsonNetlist {
  const canonical = unionNets(json);
  if (canonical.size === 0) return json;

  return {
    ...json,
    components: json.components.map((c) => ({
      ...c,
      net_pos: remapNetId(canonical, c.net_pos) ?? c.net_pos,
      net_neg: remapNetId(canonical, c.net_neg) ?? c.net_neg,
    })),
    component_details: json.component_details?.map((d) => ({
      ...d,
      pins: d.pins.map((p) => ({ ...p, net_id: remapNetId(canonical, p.net_id) })),
    })),
    nets: json.nets?.map((n) => ({ ...n, id: remapNetId(canonical, n.id) ?? n.id })),
  };
}

// ─── Value parsing ────────────────────────────────────────────────────────────

function parseValue(val: string): number {
  // Handle "DC 5", "AC 12", etc. — strip leading qualifier
  const stripped = val.replace(/^(dc|ac)\s+/i, "").trim();
  const m = stripped.match(/^([0-9.]+)\s*([kmupnfMGTPEZYKμ]?)/i);
  if (!m) return parseFloat(stripped) || 0;
  const num = parseFloat(m[1]);
  const sfx: Record<string, number> = {
    T: 1e12, G: 1e9, M: 1e6, k: 1e3, K: 1e3,
    "": 1,
    m: 1e-3, u: 1e-6, μ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
  };
  return num * (sfx[m[2]] ?? 1);
}

function buildParams(kind: ComponentKind, value: string): Record<string, number> {
  const def = getDef(kind);
  const base: Record<string, number> = Object.fromEntries(
    def.params.map((p) => [p.key, p.default])
  );
  const num = parseValue(value);
  if (num !== 0 && def.params.length > 0) {
    base[def.params[0].key] = num;
  }
  return base;
}

// ─── Coordinate transform (pixel → grid) ─────────────────────────────────────

const CANVAS_MARGIN = 4;  // grid units of padding around the placed circuit
const TARGET_W      = 26; // target canvas width in grid units
const TARGET_H      = 22; // target canvas height in grid units

/** Tolerance (px) within which two coordinates are considered the same rail. */
export const CLUSTER_TOLERANCE_PX = 50;

export interface PixelToGrid {
  toGrid: (px: number, py: number) => { x: number; y: number };
  /** Variant that applies coordinate clustering before converting. */
  toGridClustered: (px: number, py: number) => { x: number; y: number };
  scale: number; // grid-units per pixel
}

/**
 * Group a list of numeric values so that any two values within `tolerance` of
 * the cluster's seed are merged.  Returns a Map from each original value to its
 * cluster representative (the median of the cluster).
 *
 * Example: [1497, 1534, 800] with tolerance=50 →
 *   1497 → 1516 (median of [1497,1534]), 1534 → 1516, 800 → 800
 */
export function clusterValues(
  values: number[],
  tolerance: number
): Map<number, number> {
  const unique = [...new Set(values)].sort((a, b) => a - b);
  const result = new Map<number, number>();
  let i = 0;
  while (i < unique.length) {
    // Grow cluster while consecutive values differ from seed by ≤ tolerance.
    let j = i + 1;
    while (j < unique.length && unique[j] - unique[i] <= tolerance) j++;
    const group = unique.slice(i, j);
    const rep = group[Math.floor(group.length / 2)]; // median
    for (const v of group) result.set(v, rep);
    i = j;
  }
  return result;
}

/**
 * Build a linear mapping from image pixel space → canvas grid space.
 * Pass `pinPixels` (all raw pin X/Y values collected from component_details)
 * so the transform can pre-cluster nearby coordinates before snapping, matching
 * the methodology: round(coord / (S × GRID_STEP)) × GRID_STEP.
 */
export function buildPixelToGrid(
  details: JsonComponentDetail[],
  pinPixels?: { xs: number[]; ys: number[] }
): PixelToGrid {
  // Build cluster maps in pixel space (50 px tolerance)
  const allXs = pinPixels?.xs ?? details.map((d) => d.bbox.cx);
  const allYs = pinPixels?.ys ?? details.map((d) => d.bbox.cy);
  const xCluster = clusterValues(allXs, CLUSTER_TOLERANCE_PX);
  const yCluster = clusterValues(allYs, CLUSTER_TOLERANCE_PX);

  // Derive extents from clustered values so the scale fits the snapped layout.
  const clusteredXs = [...new Set([...xCluster.values()])];
  const clusteredYs = [...new Set([...yCluster.values()])];
  const minX = Math.min(...clusteredXs);
  const minY = Math.min(...clusteredYs);
  const maxX = Math.max(...clusteredXs);
  const maxY = Math.max(...clusteredYs);

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const innerW = TARGET_W - CANVAS_MARGIN * 2;
  const innerH = TARGET_H - CANVAS_MARGIN * 2;

  // Uniform scale so the schematic isn't distorted.
  const scale = Math.min(innerW / rangeX, innerH / rangeY);

  // Centre the circuit within the target area.
  const offsetX = CANVAS_MARGIN + (innerW - rangeX * scale) / 2 - minX * scale;
  const offsetY = CANVAS_MARGIN + (innerH - rangeY * scale) / 2 - minY * scale;

  const rawToGrid = (px: number, py: number) => ({
    x: snap(px * scale + offsetX),
    y: snap(py * scale + offsetY),
  });

  const clusteredToGrid = (px: number, py: number) => {
    const cx = xCluster.get(px) ?? px;
    const cy = yCluster.get(py) ?? py;
    return rawToGrid(cx, cy);
  };

  return { toGrid: rawToGrid, toGridClustered: clusteredToGrid, scale };
}

// ─── Orientation from detected pin pixels ─────────────────────────────────────

/**
 * Every two-pin component def places pin[0] at local (-1, 0) ("left") and
 * pin[1] at local (1, 0) ("right"). Derive the rotation/mirroring that makes
 * those two pins land where the backend actually detected them in the photo
 * (terminal_extractor.py reports left/right for horizontal parts and
 * top/bottom for vertical ones), so the drawn symbol's orientation — and the
 * wires leaving it — match the source image instead of always defaulting to
 * a flat horizontal layout.
 */
function computeOrientationFromPixels(
  p1: { x: number; y: number },
  p2: { x: number; y: number }
): { rotation: Rotation; mirrored: boolean } {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal: mirror when pin[0] is actually on the right in the photo.
    return { rotation: 0, mirrored: dx < 0 };
  }
  // Vertical: rotate so pin[0]/pin[1] land on top/bottom as detected.
  return { rotation: dy > 0 ? 90 : 270, mirrored: false };
}

/** Apply photo-derived orientation to a placed instance, using its detected
 *  pin pixel positions. No-op for components without exactly two named pins
 *  matching the def (e.g. Ground), which stay at the default orientation. */
function applyPixelOrientation(
  instance: ComponentInstance,
  detail: JsonComponentDetail
): void {
  const def = getDef(instance.kind);
  if (def.pins.length !== 2) return;
  const p1 = detail.pins.find((p) => p.name.toLowerCase() === def.pins[0].name.toLowerCase());
  const p2 = detail.pins.find((p) => p.name.toLowerCase() === def.pins[1].name.toLowerCase());
  if (!p1 || !p2) return;
  const { rotation, mirrored } = computeOrientationFromPixels(p1, p2);
  instance.rotation = rotation;
  instance.mirrored = mirrored;
}

// ─── Fallback auto-layout (old format, no component_details) ─────────────────

function autoLayout(count: number): { x: number; y: number }[] {
  const COLS = 4;
  const COL_STEP = 6;
  const ROW_STEP = 5;
  const START_X = 6;
  const START_Y = 6;
  return Array.from({ length: count }, (_, i) => ({
    x: snap(START_X + (i % COLS) * COL_STEP),
    y: snap(START_Y + Math.floor(i / COLS) * ROW_STEP),
  }));
}

// ─── Topology-aware layout ────────────────────────────────────────────────

/** Internal pairing of a placed instance with its raw JSON data. */
interface MappedComp {
  instance: ComponentInstance;
  jsonComp: JsonComponent;
  /** Set during chain tracing: true if this component was entered via its
   *  net_pos ("A"/"+") terminal, false if entered via net_neg ("B"/"-").
   *  Undefined for the chain's start component (no incoming wire). */
  entryIsPos?: boolean;
}

/**
 * Walk the series chain through the circuit graph defined by each component's
 * `net_pos` / `net_neg` terminals.  Starts from the voltage source (preferred)
 * and follows shared nets to discover the traversal order.
 *
 * Returns all mapped components in chain order; any orphaned (disconnected)
 * components are appended at the end.
 */
function traceSeriesChain(mapped: MappedComp[]): MappedComp[] {
  if (mapped.length === 0) return [];

  // net_id → [ref_des] of all components that touch that net
  const netToRefs = new Map<string, string[]>();
  for (const m of mapped) {
    for (const net of [m.jsonComp.net_pos, m.jsonComp.net_neg]) {
      if (!net) continue;
      if (!netToRefs.has(net)) netToRefs.set(net, []);
      netToRefs.get(net)!.push(m.jsonComp.ref_des);
    }
  }

  const refMap = new Map(mapped.map((m) => [m.jsonComp.ref_des, m]));

  // Prefer starting with a voltage source so schematic reads "V first".
  const startM =
    mapped.find((m) => m.instance.kind.startsWith("vsource")) ?? mapped[0];

  const chain: MappedComp[] = [startM];
  const visited = new Set<string>([startM.jsonComp.ref_des]);

  // Walk from the negative terminal outward through the loop. The start
  // component is conceptually "entered" via its positive terminal (current
  // flows out through net_neg), so its pos pin should face the previous
  // element in the loop once it closes — i.e. face left in the top-left slot.
  startM.entryIsPos = true;
  let currentNet = startM.jsonComp.net_neg ?? startM.jsonComp.net_pos ?? "";

  for (let step = 0; step < mapped.length - 1; step++) {
    const next = (netToRefs.get(currentNet) ?? []).find((r) => !visited.has(r));
    if (!next) break;
    const nextM = refMap.get(next)!;
    const enteredViaNeg = nextM.jsonComp.net_neg === currentNet;
    nextM.entryIsPos = !enteredViaNeg;
    chain.push(nextM);
    visited.add(next);
    // Advance to the OTHER terminal of this component.
    currentNet = enteredViaNeg
      ? (nextM.jsonComp.net_pos ?? "")
      : (nextM.jsonComp.net_neg ?? "");
  }

  // Append any orphaned / disconnected components.
  for (const m of mapped) {
    if (!visited.has(m.jsonComp.ref_des)) chain.push(m);
  }

  return chain;
}

/**
 * Assign grid positions to a chain of components so they form a neat
 * rectangular loop:
 *
 *   chain[0] ─ chain[1] ─ ─ chain[topN-1]
 *       |                          |
 *   chain[N-1] ─ ... ─ chain[topN]
 *
 * Components on the top branch go left→right; bottom branch right→left so
 * that adjacent pairs in chain order remain geometrically adjacent, keeping
 * the auto-routed wires short and straight.
 */
function placeInLoop(chain: MappedComp[]): void {
  const N = chain.length;
  if (N === 0) return;
  if (N === 1) {
    chain[0].instance.x = snap(TARGET_W / 2);
    chain[0].instance.y = snap(TARGET_H / 2);
    return;
  }

  const topN = Math.ceil(N / 2);
  const botN = N - topN;

  // Horizontal step between successive components on the same branch.
  const STEP   = 5; // grid units
  const START_X = CANVAS_MARGIN + 2;
  const TOP_Y   = CANVAS_MARGIN + 4;
  const BOT_Y   = CANVAS_MARGIN + 4 + 6; // 6 grid-unit vertical gap

  // Each part's def places pin[0] ("A"/"+"/net_pos) on the left and pin[1]
  // ("B"/"-"/net_neg) on the right by default. Flip (mirror) it whenever that
  // would put the entry pin (the one wired to the *previous* part in chain
  // order) on the wrong side — otherwise the auto-routed wire has to loop
  // back across the component body instead of running straight to its
  // left/right neighbor.
  for (let i = 0; i < topN; i++) {
    // Top branch runs left→right: entry pin should face left.
    chain[i].instance.x = snap(START_X + i * STEP);
    chain[i].instance.y = snap(TOP_Y);
    chain[i].instance.mirrored = chain[i].entryIsPos === false;
  }

  for (let i = 0; i < botN; i++) {
    // Bottom branch runs right→left (mirrors the top row positionally so
    // chain[topN] sits directly below chain[topN-1]): entry pin should
    // face right instead.
    const m = chain[topN + i];
    m.instance.x = snap(START_X + (topN - 1 - i) * STEP);
    m.instance.y = snap(BOT_Y);
    m.instance.mirrored = m.entryIsPos !== false;
  }
}

// ─── Wire building: primary — net_id from component_details pins ──────────────

/**
 * PRIMARY wire builder (Rich format).
 * Reads `net_id` directly from each pin in `component_details`.  Because these
 * labels are assigned by the backend topology solver (not derived from fragile
 * pixel proximity), this is far more reliable than segment union-find.
 *
 * Pins sharing the same net_id are grouped; adjacent pairs in each group are
 * connected with a Wire. Falls back gracefully when net_id is absent.
 */
function buildWiresFromPinNetIds(
  details: JsonComponentDetail[],
  refToInstance: Map<string, ComponentInstance>
): Wire[] {
  const netToPins = new Map<string, PinRef[]>();

  for (const detail of details) {
    const inst = refToInstance.get(detail.ref_des);
    if (!inst) continue;
    const def = getDef(inst.kind);

    for (const pinDetail of detail.pins) {
      if (!pinDetail.net_id) continue;
      const pinDef = def.pins.find(
        (p) => p.name.toLowerCase() === pinDetail.name.toLowerCase()
      );
      if (!pinDef) continue;
      const ref: PinRef = { componentId: inst.id, pinId: pinDef.id };
      if (!netToPins.has(pinDetail.net_id)) netToPins.set(pinDetail.net_id, []);
      netToPins.get(pinDetail.net_id)!.push(ref);
    }
  }

  const wires: Wire[] = [];
  const seenPairs = new Set<string>();

  function addWire(from: PinRef, to: PinRef) {
    const key = [`${from.componentId}:${from.pinId}`, `${to.componentId}:${to.pinId}`]
      .sort()
      .join("|");
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    wires.push({ id: uuid(), from, to });
  }

  for (const pins of netToPins.values()) {
    if (pins.length < 2) continue;
    // Chain the pins in this net so every adjacent pair gets a wire.
    for (let i = 0; i < pins.length - 1; i++) addWire(pins[i], pins[i + 1]);
  }

  return wires;
}

// ─── Wire building: secondary — segment union-find (pixel proximity) ──────────

/**
 * SECONDARY wire builder.  Used when pin net_id is absent but the JSON contains
 * detected wire segments.  Runs a union-find over segment endpoints + pin pixel
 * positions to determine physical connectivity.
 */
function buildWiresFromSegments(
  segments: JsonWireSegment[],
  details: JsonComponentDetail[],
  refToInstance: Map<string, ComponentInstance>,
  snapTolerance: number
): Wire[] {
  interface PoolPoint { x: number; y: number; id: number }
  const pool: PoolPoint[] = [];
  let nextPtId = 0;

  function findOrAdd(x: number, y: number): number {
    for (const p of pool) {
      if (Math.hypot(p.x - x, p.y - y) <= snapTolerance) return p.id;
    }
    const id = nextPtId++;
    pool.push({ x, y, id });
    return id;
  }

  // Register pin positions first so they anchor the clusters.
  const pinAtPoint = new Map<number, PinRef>();
  for (const detail of details) {
    const inst = refToInstance.get(detail.ref_des);
    if (!inst) continue;
    const def = getDef(inst.kind);
    for (const pinDetail of detail.pins) {
      const pinDef = def.pins.find(
        (p) => p.name.toLowerCase() === pinDetail.name.toLowerCase()
      );
      if (!pinDef) continue;
      const ptId = findOrAdd(pinDetail.x, pinDetail.y);
      if (!pinAtPoint.has(ptId))
        pinAtPoint.set(ptId, { componentId: inst.id, pinId: pinDef.id });
    }
  }

  // Register segment endpoints.
  const edges: { a: number; b: number }[] = [];
  for (const seg of segments) {
    edges.push({ a: findOrAdd(seg.x1, seg.y1), b: findOrAdd(seg.x2, seg.y2) });
  }

  // Union-Find
  const parent = Array.from({ length: nextPtId }, (_, i) => i);
  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (const { a, b } of edges) union(a, b);

  // Group pins by connected component
  const rootToPins = new Map<number, PinRef[]>();
  for (const [ptId, pinRef] of pinAtPoint) {
    const root = find(ptId);
    if (!rootToPins.has(root)) rootToPins.set(root, []);
    rootToPins.get(root)!.push(pinRef);
  }

  const wires: Wire[] = [];
  const seenPairs = new Set<string>();
  function addWire(from: PinRef, to: PinRef) {
    const key = [`${from.componentId}:${from.pinId}`, `${to.componentId}:${to.pinId}`]
      .sort().join("|");
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    wires.push({ id: uuid(), from, to });
  }
  for (const pins of rootToPins.values()) {
    if (pins.length < 2) continue;
    for (let i = 0; i < pins.length - 1; i++) addWire(pins[i], pins[i + 1]);
  }
  return wires;
}

// ─── Wire building: tertiary — net-array inference (old format) ───────────────

function buildWiresFromNets(
  nets: JsonNet[],
  refToInstance: Map<string, ComponentInstance>
): Wire[] {
  const wires: Wire[] = [];
  const seenPairs = new Set<string>();

  function addWire(from: PinRef, to: PinRef) {
    const key = [`${from.componentId}:${from.pinId}`, `${to.componentId}:${to.pinId}`]
      .sort().join("|");
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    wires.push({ id: uuid(), from, to });
  }

  for (const net of nets) {
    const refs: PinRef[] = [];
    for (const pinStr of net.pins) {
      const dotIdx = pinStr.lastIndexOf(".");
      if (dotIdx === -1) continue;
      const refDes = pinStr.slice(0, dotIdx);
      const pinName = pinStr.slice(dotIdx + 1);
      const inst = refToInstance.get(refDes);
      if (!inst) continue;
      const def = getDef(inst.kind);
      const pin = def.pins.find(
        (p) => p.name.toLowerCase() === pinName.toLowerCase()
      );
      if (!pin) continue;
      refs.push({ componentId: inst.id, pinId: pin.id });
    }
    for (let i = 0; i < refs.length - 1; i++) addWire(refs[i], refs[i + 1]);
  }

  return wires;
}

// ─── Overlap resolution: rotate components to un-overlap auto-routed wires ────

interface GPoint {
  x: number;
  y: number;
}

function pinWorld(ref: PinRef, byId: Map<string, ComponentInstance>): GPoint {
  const inst = byId.get(ref.componentId)!;
  const pinDef = getDef(inst.kind).pins.find((p) => p.id === ref.pinId)!;
  return resolvePinWorld(inst, pinDef);
}

function pinDir(ref: PinRef, byId: Map<string, ComponentInstance>): GPoint {
  const inst = byId.get(ref.componentId)!;
  const pinDef = getDef(inst.kind).pins.find((p) => p.id === ref.pinId)!;
  return pinDirection(inst, pinDef);
}

function pathSegments(path: GPoint[]): [GPoint, GPoint][] {
  const segs: [GPoint, GPoint][] = [];
  for (let i = 0; i < path.length - 1; i++) segs.push([path[i], path[i + 1]]);
  return segs;
}

/** True if two axis-aligned segments run collinear and overlap for a
 *  non-zero length — i.e. two wires visibly drawn on top of each other,
 *  not just crossing or touching at a single point. */
function segmentsOverlap(a: [GPoint, GPoint], b: [GPoint, GPoint]): boolean {
  const [a1, a2] = a;
  const [b1, b2] = b;
  if (a1.x === a2.x && b1.x === b2.x && a1.x === b1.x) {
    const aLo = Math.min(a1.y, a2.y), aHi = Math.max(a1.y, a2.y);
    const bLo = Math.min(b1.y, b2.y), bHi = Math.max(b1.y, b2.y);
    return Math.min(aHi, bHi) - Math.max(aLo, bLo) > 0;
  }
  if (a1.y === a2.y && b1.y === b2.y && a1.y === b1.y) {
    const aLo = Math.min(a1.x, a2.x), aHi = Math.max(a1.x, a2.x);
    const bLo = Math.min(b1.x, b2.x), bHi = Math.max(b1.x, b2.x);
    return Math.min(aHi, bHi) - Math.max(aLo, bLo) > 0;
  }
  return false;
}

function countWireOverlaps(components: ComponentInstance[], wires: Wire[]): number {
  const byId = new Map(components.map((c) => [c.id, c]));
  const allSegs = wires.map((w) =>
    pathSegments(
      orthogonalPath(
        pinWorld(w.from, byId),
        pinWorld(w.to, byId),
        pinDir(w.from, byId),
        pinDir(w.to, byId)
      )
    )
  );
  let count = 0;
  for (let i = 0; i < allSegs.length; i++) {
    for (let j = i + 1; j < allSegs.length; j++) {
      for (const segA of allSegs[i]) {
        for (const segB of allSegs[j]) {
          if (segmentsOverlap(segA, segB)) count++;
        }
      }
    }
  }
  return count;
}

const ALL_ROTATIONS: Rotation[] = [0, 90, 180, 270];

/**
 * Post-layout pass: the auto-router (orthogonalPath) draws a straight or
 * single-elbow line between two pins with no collision avoidance, so on a
 * dense auto-generated loop two wires can end up running collinear along the
 * same stretch of grid. Since a component's rotation/mirroring changes where
 * its pins sit — and therefore every wire attached to it — trying different
 * orientations can route a wire clear of another without moving anything.
 *
 * Greedy local search: for each component touched by a wire, try every
 * rotation × mirror combination and keep whichever strictly reduces the
 * total overlap count. Not guaranteed to reach zero (some layouts can't be
 * fixed by rotation alone), but it never makes overlap worse and terminates
 * in one pass over the components involved.
 */
function resolveWireOverlaps(components: ComponentInstance[], wires: Wire[]): void {
  if (wires.length < 2) return;

  const touchedIds = new Set<string>();
  for (const w of wires) {
    touchedIds.add(w.from.componentId);
    touchedIds.add(w.to.componentId);
  }
  const candidates = components.filter((c) => touchedIds.has(c.id));

  for (const comp of candidates) {
    let bestOverlaps = countWireOverlaps(components, wires);
    if (bestOverlaps === 0) break;

    const original = { rotation: comp.rotation, mirrored: comp.mirrored };
    let best = original;

    for (const rotation of ALL_ROTATIONS) {
      for (const mirrored of [false, true]) {
        if (rotation === original.rotation && mirrored === original.mirrored) continue;
        comp.rotation = rotation;
        comp.mirrored = mirrored;
        const n = countWireOverlaps(components, wires);
        if (n < bestOverlaps) {
          bestOverlaps = n;
          best = { rotation, mirrored };
        }
      }
    }
    comp.rotation = best.rotation;
    comp.mirrored = best.mirrored;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function loadNetlistJson(rawJson: JsonNetlist): LoadResult {
  const json = bridgeSkippedComponentNets(rawJson);
  const skipped: string[] = [];
  const usedRefIds = new Set<string>();

  const mapped: MappedComp[] = [];

  for (const jc of json.components) {
    const kind = typeToKind(jc.type);
    if (!kind) {
      skipped.push(jc.ref_des);
      continue;
    }
    const refId = usedRefIds.has(jc.ref_des)
      ? `${jc.ref_des}_${uuid().slice(0, 4)}`
      : jc.ref_des;
    usedRefIds.add(refId);

    const instance: ComponentInstance = {
      id: uuid(),
      kind,
      refId,
      x: 0,
      y: 0,
      rotation: 0,
      mirrored: false,
      params: buildParams(kind, jc.value),
    };
    mapped.push({ instance, jsonComp: jc });
  }

  const refToInstance = new Map<string, ComponentInstance>(
    mapped.map((m) => [m.jsonComp.ref_des, m.instance])
  );

  // 2. Position components
  //
  //  Priority:
  //    a) Photo-coordinate layout — when every placed part has a detected
  //       bbox + pins, keep it where it was drawn, oriented the way its
  //       wires actually leave it. This reproduces the source drawing.
  //    b) Topology layout — no geometry but net_pos/net_neg are known: trace
  //       the series chain and arrange it in a clean rectangle.
  //    c) Auto-grid — last resort for minimal old-format JSON.
  const details = json.component_details ?? [];
  const detailMap = new Map<string, JsonComponentDetail>(
    details.map((d) => [d.ref_des, d])
  );

  let p2g: PixelToGrid | null = null;

  const hasNetTopology = mapped.some(
    (m) => m.jsonComp.net_pos || m.jsonComp.net_neg
  );
  const hasFullGeometry =
    mapped.length > 0 &&
    mapped.every((m) => (detailMap.get(m.jsonComp.ref_des)?.pins.length ?? 0) > 0);

  if (!hasFullGeometry && hasNetTopology) {
    const chain = traceSeriesChain(mapped);
    placeInLoop(chain);
  } else if (details.length > 0) {
    const allPinXs: number[] = [];
    const allPinYs: number[] = [];
    for (const d of details) {
      allPinXs.push(d.bbox.cx);
      allPinYs.push(d.bbox.cy);
      for (const pin of d.pins) {
        allPinXs.push(pin.x);
        allPinYs.push(pin.y);
      }
    }
    p2g = buildPixelToGrid(details, { xs: allPinXs, ys: allPinYs });
    mapped.forEach((m, idx) => {
      const detail = detailMap.get(m.jsonComp.ref_des);
      if (detail) {
        const g = p2g!.toGridClustered(detail.bbox.cx, detail.bbox.cy);
        m.instance.x = g.x;
        m.instance.y = g.y;
        applyPixelOrientation(m.instance, detail);
      } else {
        m.instance.x = snap(6 + idx * 6);
        m.instance.y = snap(2);
      }
    });
  } else {
    const positions = autoLayout(mapped.length);
    mapped.forEach((m, i) => {
      m.instance.x = positions[i].x;
      m.instance.y = positions[i].y;
    });
  }

  const components = mapped.map((m) => m.instance);

  let wires: Wire[] = [];

  const hasDetails  = details.length > 0;
  const hasSegments = (json.wires?.segments?.length ?? 0) > 0;

  const hasPinNetIds = hasDetails &&
    details.some((d) => d.pins.some((p) => !!p.net_id));

  if (hasPinNetIds) {
    wires = buildWiresFromPinNetIds(details, refToInstance);
  }

  if (wires.length === 0 && json.nets) {
    wires = buildWiresFromNets(json.nets, refToInstance);
  }

  if (wires.length === 0 && hasSegments && hasDetails && p2g) {
    const snapTolerance = Math.max((1 / p2g.scale) * 1.5, 80);
    wires = buildWiresFromSegments(
      json.wires!.segments,
      details,
      refToInstance,
      snapTolerance
    );
  }

  // 4. If any auto-routed wires visually overlap, try rotating/mirroring the
  //    components they connect to find an orientation that clears them.
  //    Not for photo layout: there the orientation comes from the drawing
  //    and must be kept as drawn.
  if (!p2g) resolveWireOverlaps(components, wires);

  // 5. Convert raw wire segments + junctions to clustered grid units
  //    for the background trace layer.  Using toGridClustered ensures the
  //    rendered segments snap to the same aligned grid as the components.
  const rawWireSegments: RawWireSegment[] = [];
  const rawJunctions: RawJunction[] = [];

  if (p2g && hasSegments) {
    for (const seg of json.wires!.segments) {
      const a = p2g.toGridClustered(seg.x1, seg.y1);
      const b = p2g.toGridClustered(seg.x2, seg.y2);
      rawWireSegments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    for (const jct of json.wires!.junctions ?? []) {
      const g = p2g.toGridClustered(jct.x, jct.y);
      rawJunctions.push({ x: g.x, y: g.y });
    }
  }

  return { components, wires, skipped, rawWireSegments, rawJunctions };
}
