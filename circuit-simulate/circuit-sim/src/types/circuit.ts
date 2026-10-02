// Core domain types shared by the whole app.
// Keep this file framework-agnostic: no React, no DOM types.

/** Every distinct part type the palette can offer. Add new kinds here first. */
export type ComponentKind =
  | "resistor"
  | "capacitor"
  | "inductor"
  | "vsource_dc"
  | "vsource_ac"
  | "battery"
  | "vsource_dep"
  | "diode"
  | "ground";

/** 0/90/180/270 degrees, clockwise. */
export type Rotation = 0 | 90 | 180 | 270;

/** A single connection point on a component, in the component's own
 *  unmirrored, unrotated local coordinate space (grid units, origin at
 *  the component's center). */
export interface PinDef {
  id: string; // stable within the component, e.g. "p1", "p2"
  /** local offset from component center, in grid units */
  local: { x: number; y: number };
  name: string; // human label, e.g. "A", "K", "+"
}

/** Static definition of a component kind: how it's drawn, its pins,
 *  and its default/editable parameters. This is data, not an instance. */
export interface ComponentDef {
  kind: ComponentKind;
  label: string; // display name, e.g. "Resistor"
  symbolId: string; // key into the symbol renderer registry
  pins: PinDef[];
  /** grid footprint used for hit-testing / bounding box, in grid units */
  size: { w: number; h: number };
  params: ParamDef[];
  /** SPICE-ish prefix used when auto-naming instances, e.g. "R" -> R1, R2 */
  refPrefix: string;
}

export type ParamUnit =
  | "ohm"
  | "farad"
  | "henry"
  | "volt"
  | "hz"
  | "none";

export interface ParamDef {
  key: string; // e.g. "resistance"
  label: string; // e.g. "Resistance"
  unit: ParamUnit;
  default: number;
  /** SI suffix editing, e.g. user can type "4.7k" -> 4700 */
  step?: number;
}

/** A placed instance of a component on the canvas. */
export interface ComponentInstance {
  id: string;
  kind: ComponentKind;
  refId: string; // auto-assigned name, e.g. "R1"
  /** position of the component's center, in grid units */
  x: number;
  y: number;
  rotation: Rotation;
  mirrored: boolean;
  params: Record<string, number>;
}

/** A reference to a specific pin of a specific placed component. */
export interface PinRef {
  componentId: string;
  pinId: string;
}

/** A wire connects exactly two pins. Routing waypoints are derived at
 *  render time (orthogonal auto-routing) unless the user has dragged
 *  custom waypoints, which are stored here in grid units. */
export interface Wire {
  id: string;
  from: PinRef;
  to: PinRef;
  waypoints?: { x: number; y: number }[];
  /** Set when the user drags the wire: its crossing run sits on this line
   *  (axis "y" = a horizontal run at y = value, "x" = a vertical run). */
  route?: WireRoute;
}

export interface WireRoute {
  axis: "x" | "y";
  value: number;
}

/** The full document that gets saved, loaded, and simulated. */
export interface SchematicDocument {
  version: 1;
  components: ComponentInstance[];
  wires: Wire[];
}

/** Resolved absolute position of a pin, used for rendering and hit-testing. */
export interface ResolvedPin {
  componentId: string;
  pinId: string;
  x: number;
  y: number;
}
