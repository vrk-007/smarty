import type { ComponentDef, ComponentKind } from "../types/circuit";

/**
 * Single source of truth for every component kind the app knows about.
 * To add a new component later: add a ComponentKind, add an entry here,
 * and add a symbol drawing in canvas/symbols.tsx keyed by `symbolId`.
 * Nothing else in the app needs to change.
 *
 * All two-terminal parts use the same local pin layout by convention:
 * pin "p1" at (-1, 0), pin "p2" at (1, 0), so wiring/rotation logic can
 * stay generic instead of special-casing each kind.
 */
export const COMPONENT_DEFS: Record<ComponentKind, ComponentDef> = {
  resistor: {
    kind: "resistor",
    label: "Resistor",
    symbolId: "resistor",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "A", local: { x: -1, y: 0 } },
      { id: "p2", name: "B", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "resistance", label: "Resistance", unit: "ohm", default: 1000 },
    ],
    refPrefix: "R",
  },

  capacitor: {
    kind: "capacitor",
    label: "Capacitor",
    symbolId: "capacitor",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "A", local: { x: -1, y: 0 } },
      { id: "p2", name: "B", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "capacitance", label: "Capacitance", unit: "farad", default: 1e-6 },
    ],
    refPrefix: "C",
  },

  inductor: {
    kind: "inductor",
    label: "Inductor",
    symbolId: "inductor",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "A", local: { x: -1, y: 0 } },
      { id: "p2", name: "B", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "inductance", label: "Inductance", unit: "henry", default: 1e-3 },
    ],
    refPrefix: "L",
  },

  vsource_dc: {
    kind: "vsource_dc",
    label: "DC Voltage Source",
    symbolId: "vsource_dc",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "+", local: { x: -1, y: 0 } },
      { id: "p2", name: "-", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "voltage", label: "Voltage", unit: "volt", default: 5 },
    ],
    refPrefix: "V",
  },

  vsource_ac: {
    kind: "vsource_ac",
    label: "AC Voltage Source",
    symbolId: "vsource_ac",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "+", local: { x: -1, y: 0 } },
      { id: "p2", name: "-", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "amplitude", label: "Amplitude", unit: "volt", default: 5 },
      { key: "frequency", label: "Frequency", unit: "hz", default: 1000 },
    ],
    refPrefix: "V",
  },

  battery: {
    kind: "battery",
    label: "Battery",
    symbolId: "battery",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "+", local: { x: -1, y: 0 } },
      { id: "p2", name: "-", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "voltage", label: "Voltage", unit: "volt", default: 9 },
    ],
    refPrefix: "V",
  },

  // Drawn as a two-terminal diamond (that is how the model detects it); its
  // controlling expression is not captured, so it is simulated at the
  // voltage set here.
  vsource_dep: {
    kind: "vsource_dep",
    label: "Dependent Voltage Source",
    symbolId: "vsource_dep",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "A", local: { x: -1, y: 0 } },
      { id: "p2", name: "B", local: { x: 1, y: 0 } },
    ],
    params: [
      { key: "voltage", label: "Voltage", unit: "volt", default: 5 },
    ],
    refPrefix: "E",
  },

  diode: {
    kind: "diode",
    label: "Diode",
    symbolId: "diode",
    size: { w: 2, h: 1 },
    pins: [
      { id: "p1", name: "anode", local: { x: -1, y: 0 } },
      { id: "p2", name: "cathode", local: { x: 1, y: 0 } },
    ],
    params: [],
    refPrefix: "D",
  },

  ground: {
    kind: "ground",
    label: "Ground",
    symbolId: "ground",
    size: { w: 1, h: 1 },
    pins: [{ id: "p1", name: "GND", local: { x: 0, y: -1 } }],
    params: [],
    refPrefix: "GND",
  },
};

export const PALETTE_ORDER: ComponentKind[] = [
  "resistor",
  "capacitor",
  "inductor",
  "vsource_dc",
  "vsource_ac",
  "battery",
  "vsource_dep",
  "diode",
  "ground",
];

export function getDef(kind: ComponentKind): ComponentDef {
  return COMPONENT_DEFS[kind];
}
