/**
 * buildCircuitJs.ts
 *
 * Converts a JsonNetlist (v2 format with backend-provided scale factors) into
 * the CircuitJS / Falstad plain-text format so it can be embedded via:
 *
 *   https://www.falstad.com/circuit/circuitjs.html?cct=<encodeURIComponent(text)>
 *
 * Coordinate mapping (per the backend integration guide):
 *   cjsX = round(pin.x * scale_x / GRID) * GRID   (snap to 16-px grid)
 *   cjsY = round(pin.y * scale_y / GRID) * GRID
 *
 * Then add OFFSET_X / OFFSET_Y so everything is visible in the viewport.
 *
 * Wire generation strategy (most-to-least reliable):
 *   1. PRIMARY  — group pins by net_id from component_details[].pins[].net_id.
 *                 This is the backend's authoritative connectivity label and
 *                 never requires cross-array string-key matching.
 *   2. FALLBACK — iterate nets[].pins[], look up each "R1.A" in the pinMap.
 *                 Used only for any nets that PRIMARY missed (e.g. virtual GND).
 */

import type { JsonNetlist, JsonComponentDetail } from "./loadNetlistJson";
import { clusterValues, CLUSTER_TOLERANCE_PX } from "./loadNetlistJson";

// ─── Constants ────────────────────────────────────────────────────────────────

const GRID = 16;        // CircuitJS default grid size (px)
const OFFSET_X = 200;   // shift right so all coords land in the visible viewport
const OFFSET_Y = 100;   // shift down

// ─── Coordinate helpers ───────────────────────────────────────────────────────

function toGrid(pixelVal: number, scale: number): number {
  const raw = pixelVal * scale;
  return Math.round(raw / GRID) * GRID;
}

function getScale(netlist: JsonNetlist): { sx: number; sy: number } {
  return {
    sx: netlist.grid?.scale_x ?? (netlist.image ? GRID / netlist.image.width  : 1),
    sy: netlist.grid?.scale_y ?? (netlist.image ? GRID / netlist.image.height : 1),
  };
}

// ─── Value parser ─────────────────────────────────────────────────────────────

export function parseValue(valueStr: string | undefined | null): number {
  if (!valueStr) return 1;
  const str = valueStr.trim();

  // "DC 5" / "AC 12" — strip leading qualifier
  const dcMatch = str.match(/^(?:DC|AC)\s*([\d.]+)/i);
  if (dcMatch) return parseFloat(dcMatch[1]);

  // Strip trailing unit letters (V, A, H, Ω, ohm, F) — keep SI prefix
  const cleaned = str.replace(/[VAHΩohm]+$/i, "").trim();

  const m = cleaned.match(/^([\d.]+)\s*([TGMkKmunpf]?)/i);
  if (!m) return parseFloat(cleaned) || 1;

  const num = parseFloat(m[1]);
  const sfx = m[2] ?? "";
  const multipliers: Record<string, number> = {
    T: 1e12, G: 1e9, M: 1e6, k: 1e3, K: 1e3,
    "": 1,
    m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
  };
  return num * (multipliers[sfx] ?? 1);
}

// ─── Pin position lookup (used only for component bodies) ─────────────────────

export interface CjsPin {
  x: number;
  y: number;
  net_id?: string;
}

/**
 * Build a map: "R1.A" → { x, y, net_id } in CircuitJS grid space.
 * Keys are normalised to lower-case to reduce mismatch risk.
 *
 * Pin pixel coordinates are pre-clustered (same 50px tolerance used by the
 * schematic canvas loader) before grid-snapping. Hand-drawn/detected pins
 * that are meant to sit on the same rail rarely land on the exact same
 * pixel, so snapping each one to the nearest 16px grid point independently
 * can put "aligned" pins on different rows/columns and draw a diagonal wire
 * between them instead of a straight one. Clustering first makes same-rail
 * pins resolve to one shared coordinate, so their wires come out straight.
 */
export function buildPinMap(netlist: JsonNetlist): Map<string, CjsPin> {
  const map = new Map<string, CjsPin>();
  const { sx, sy } = getScale(netlist);

  const details = netlist.component_details ?? [];
  const xCluster = clusterValues(details.flatMap((d) => d.pins.map((p) => p.x)), CLUSTER_TOLERANCE_PX);
  const yCluster = clusterValues(details.flatMap((d) => d.pins.map((p) => p.y)), CLUSTER_TOLERANCE_PX);

  for (const comp of details) {
    for (const pin of comp.pins) {
      const cx = xCluster.get(pin.x) ?? pin.x;
      const cy = yCluster.get(pin.y) ?? pin.y;
      // Store under multiple key variants so we survive pin-name differences
      const base = `${comp.ref_des}.${pin.name}`;
      const pos: CjsPin = {
        x: toGrid(cx, sx) + OFFSET_X,
        y: toGrid(cy, sy) + OFFSET_Y,
        net_id: pin.net_id,
      };
      map.set(base, pos);
      map.set(base.toLowerCase(), pos);
    }
  }

  return map;
}

// ─── Net → positions index (primary source for wires) ────────────────────────

/**
 * Scan every pin in component_details and group its grid position by net_id.
 * This is the most reliable connectivity source — it does NOT require matching
 * strings across the `nets[]` and `component_details[]` arrays.
 */
function buildNetPositions(
  netlist: JsonNetlist,
  pinMap: Map<string, CjsPin>
): Map<string, { x: number; y: number }[]> {
  const map = new Map<string, { x: number; y: number }[]>();

  for (const comp of netlist.component_details ?? []) {
    for (const pin of comp.pins) {
      if (!pin.net_id) continue;
      // Reuse the already-clustered/grid-snapped position from pinMap so
      // wire endpoints exactly match the coordinates the component itself
      // was drawn at.
      const pos = pinMap.get(`${comp.ref_des}.${pin.name}`);
      if (!pos) continue;
      if (!map.has(pin.net_id)) map.set(pin.net_id, []);
      map.get(pin.net_id)!.push({ x: pos.x, y: pos.y });
    }
  }

  return map;
}

// ─── Component line builder ───────────────────────────────────────────────────

/**
 * Positive-terminal pin aliases — for voltage sources, CircuitJS places the
 * "+" terminal at (x1,y1).  We want to make sure p1 = positive pin.
 */
const POS_PIN_NAMES = new Set(["+", "pos", "p", "a", "anode", "vcc", "drain"]);
const NEG_PIN_NAMES = new Set(["-", "neg", "n", "b", "k", "cathode", "gnd", "source"]);

function orderPins(
  pins: JsonComponentDetail["pins"],
  pinMap: Map<string, CjsPin>,
  ref: string,
  type: string
): [CjsPin, CjsPin] | null {
  if (pins.length < 2) return null;

  const lookup = (name: string): CjsPin | undefined =>
    pinMap.get(`${ref}.${name}`) ?? pinMap.get(`${ref}.${name}`.toLowerCase());

  const p0 = lookup(pins[0].name);
  const p1 = lookup(pins[1].name);
  if (!p0 || !p1) return null;

  // For voltage / battery sources: ensure positive pin is first (p0)
  // so CircuitJS renders the + label at the correct end.
  const t = type.toLowerCase();
  if (t === "voltage" || t === "battery" || t === "vsource_dc" || t === "dc voltage" || t === "dc" ||
      t === "vsource_ac" || t === "ac voltage" || t === "ac" ||
      t === "vsource_dep" || t === "dep. voltage") {
    const name0 = pins[0].name.toLowerCase();
    const name1 = pins[1].name.toLowerCase();
    const p0IsNeg = NEG_PIN_NAMES.has(name0);
    const p1IsPos = POS_PIN_NAMES.has(name1);
    if (p0IsNeg || p1IsPos) {
      // Swap so positive is first
      return [p1, p0];
    }
  }

  return [p0, p1];
}

function componentLine(
  comp: JsonNetlist["components"][number],
  detail: JsonComponentDetail,
  pinMap: Map<string, CjsPin>
): string | null {
  const ref  = comp.ref_des;
  const type = comp.type.toLowerCase().trim();

  // Ground: single-terminal — emit at first pin position
  if (type === "ground" || type === "gnd") {
    const lookup = (name: string) =>
      pinMap.get(`${ref}.${name}`) ?? pinMap.get(`${ref}.${name}`.toLowerCase());
    const p = detail.pins.length > 0 ? lookup(detail.pins[0].name) : undefined;
    if (!p) return null;
    return `g ${p.x} ${p.y} 0 0 0`;
  }

  const ordered = orderPins(detail.pins, pinMap, ref, comp.type);
  if (!ordered) return null;

  const [p1, p2] = ordered;
  const x1 = p1.x, y1 = p1.y;
  const x2 = p2.x, y2 = p2.y;
  const val = parseValue(comp.value);

  switch (type) {
    case "resistor":                    return `r ${x1} ${y1} ${x2} ${y2} 0 ${val}`;
    case "capacitor":                   return `c ${x1} ${y1} ${x2} ${y2} 0 ${val}`;
    case "inductor":                    return `l ${x1} ${y1} ${x2} ${y2} 0 ${val}`;
    case "diode":
    case "led":                         return `d ${x1} ${y1} ${x2} ${y2} 2 default`;
    case "zener":                       return `z ${x1} ${y1} ${x2} ${y2} 2 default`;
    case "voltage":
    case "battery":
    case "vsource_dc":
    case "dc voltage":
    case "dc":
    case "dep. voltage":
    case "vsource_dep":                 return `v ${x1} ${y1} ${x2} ${y2} 0 0 40 ${val} 0 0 0.5`;
    case "vsource_ac":
    case "ac voltage":
    case "ac source":
    case "ac":                          return `v ${x1} ${y1} ${x2} ${y2} 0 1 40 0 ${val} 1000 0`;
    case "npn":
    case "bjt_npn":
    case "pnp":
    case "bjt_pnp":
    case "nmos":
    case "pmos":                        return null;   // not supported in text format
    default:                            return `r ${x1} ${y1} ${x2} ${y2} 0 ${val}`;
  }
}

// ─── Wire generation ──────────────────────────────────────────────────────────

function emitWires(
  netPositions: Map<string, { x: number; y: number }[]>
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  function addWire(ax: number, ay: number, bx: number, by: number) {
    if (ax === bx && ay === by) return;   // zero-length
    const key = [[ax, ay], [bx, by]]
      .map((p) => p.join(","))
      .sort()
      .join("|");
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(`w ${ax} ${ay} ${bx} ${by} 0`);
  }

  for (const positions of netPositions.values()) {
    if (positions.length < 2) continue;
    // Chain: p0→p1→p2→…  (spanning tree for n-pin nets)
    for (let i = 0; i < positions.length - 1; i++) {
      addWire(positions[i].x, positions[i].y, positions[i + 1].x, positions[i + 1].y);
    }
  }

  return lines;
}

/**
 * Fallback wire source: for any net in `nets[]` whose pins couldn't be
 * resolved via the net_id index, try the pinMap string-key lookup.
 * Handles edge cases like virtual GND nodes that lack a net_id on their pins.
 */
function wireLinesFallback(
  netlist: JsonNetlist,
  pinMap: Map<string, CjsPin>,
  alreadyCoveredNets: Set<string>
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  function addWire(ax: number, ay: number, bx: number, by: number) {
    if (ax === bx && ay === by) return;
    const key = [[ax, ay], [bx, by]].map((p) => p.join(",")).sort().join("|");
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(`w ${ax} ${ay} ${bx} ${by} 0`);
  }

  for (const net of netlist.nets ?? []) {
    if (alreadyCoveredNets.has(net.id)) continue;
    if (net.pins.length < 2) continue;

    for (let i = 0; i < net.pins.length - 1; i++) {
      const keyA = net.pins[i];
      const keyB = net.pins[i + 1];
      const pa = pinMap.get(keyA) ?? pinMap.get(keyA.toLowerCase());
      const pb = pinMap.get(keyB) ?? pinMap.get(keyB.toLowerCase());
      if (!pa || !pb) continue;
      addWire(pa.x, pa.y, pb.x, pb.y);
    }
  }

  return lines;
}

// ─── Main exports ─────────────────────────────────────────────────────────────

export function buildCircuitText(netlist: JsonNetlist): string {
  const details = netlist.component_details ?? [];
  const detailMap = new Map(details.map((d) => [d.ref_des, d]));
  const pinMap = buildPinMap(netlist);

  // PRIMARY wire source: group pin positions by net_id
  const netPositions = buildNetPositions(netlist, pinMap);

  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`$ 1 0.000005 10.20 50 5 50 5e-11`);

  // ── Components ────────────────────────────────────────────────────────────
  for (const comp of netlist.components) {
    const detail = detailMap.get(comp.ref_des);
    if (!detail) continue;
    const line = componentLine(comp, detail, pinMap);
    if (line) lines.push(line);
  }

  // ── Wires (primary: net_id-based) ─────────────────────────────────────────
  for (const wl of emitWires(netPositions)) {
    lines.push(wl);
  }

  // ── Wires (fallback: nets[]-based pinMap lookup for anything missed) ───────
  const coveredNetIds = new Set(netPositions.keys());
  for (const wl of wireLinesFallback(netlist, pinMap, coveredNetIds)) {
    lines.push(wl);
  }

  return lines.join("\n");
}

export function buildFalstadUrl(netlist: JsonNetlist): string {
  const text = buildCircuitText(netlist);
  return `https://www.falstad.com/circuit/circuitjs.html?cct=${encodeURIComponent(text)}`;
}
