import type { ReactElement } from "react";
import { GRID_SIZE as S } from "../utils/geometry";

/** Every symbol is drawn centered on (0,0) in local grid-unit space, then
 *  the caller wraps it in a <g transform="translate/rotate/scale"> — so
 *  these components never worry about the instance's position or rotation.
 *  `stroke` should be passed through so selection/hover states recolor
 *  the artwork instead of drawing a second outline on top of it. */
export interface SymbolProps {
  stroke: string;
  strokeWidth?: number;
}

const commonProps = (stroke: string, width: number) => ({
  stroke,
  strokeWidth: width,
  fill: "none",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export function ResistorSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  // Leads from the pins at x=-1/1 into the zigzag body between x=-0.6/0.6.
  const zig = [
    [-0.6, 0],
    [-0.45, -0.28],
    [-0.15, 0.28],
    [0.15, -0.28],
    [0.45, 0.28],
    [0.6, 0],
  ]
    .map(([x, y]) => `${x * S},${y * S}`)
    .join(" ");
  return (
    <g>
      <line x1={-S} y1={0} x2={-0.6 * S} y2={0} {...p} />
      <polyline points={zig} {...p} />
      <line x1={0.6 * S} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function CapacitorSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  return (
    <g>
      <line x1={-S} y1={0} x2={-0.15 * S} y2={0} {...p} />
      <line x1={-0.15 * S} y1={-0.45 * S} x2={-0.15 * S} y2={0.45 * S} {...p} />
      <line x1={0.15 * S} y1={-0.45 * S} x2={0.15 * S} y2={0.45 * S} {...p} />
      <line x1={0.15 * S} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function InductorSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  const bumps = [-0.6, -0.2, 0.2, 0.6];
  return (
    <g>
      <line x1={-S} y1={0} x2={-0.8 * S} y2={0} {...p} />
      {bumps.map((cx) => (
        <path
          key={cx}
          d={`M ${(cx - 0.2) * S} 0 A ${0.2 * S} ${0.2 * S} 0 0 1 ${(cx + 0.2) * S} 0`}
          {...p}
        />
      ))}
      <line x1={0.8 * S} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function VSourceDcSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  const r = 0.45 * S;
  return (
    <g>
      <line x1={-S} y1={0} x2={-r} y2={0} {...p} />
      <circle cx={0} cy={0} r={r} {...p} />
      <line x1={-0.18 * S} y1={0} x2={0.02 * S} y2={0} {...p} />
      <line x1={-0.08 * S} y1={-0.1 * S} x2={-0.08 * S} y2={0.1 * S} {...p} />
      <line x1={0.22 * S} y1={0} x2={0.42 * S} y2={0} {...p} />
      <line x1={r} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function VSourceAcSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  const r = 0.45 * S;
  return (
    <g>
      <line x1={-S} y1={0} x2={-r} y2={0} {...p} />
      <circle cx={0} cy={0} r={r} {...p} />
      <path
        d={`M ${-0.25 * S} 0 Q ${-0.12 * S} ${-0.22 * S} 0 0 Q ${0.12 * S} ${0.22 * S} ${0.25 * S} 0`}
        {...p}
      />
      <line x1={r} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function BatterySymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  // Long plate = + (pin p1, left), short plate = - (pin p2, right).
  return (
    <g>
      <line x1={-S} y1={0} x2={-0.15 * S} y2={0} {...p} />
      <line x1={-0.15 * S} y1={-0.5 * S} x2={-0.15 * S} y2={0.5 * S} {...p} />
      <line x1={0.15 * S} y1={-0.25 * S} x2={0.15 * S} y2={0.25 * S} {...p} strokeWidth={strokeWidth * 1.8} />
      <line x1={0.15 * S} y1={0} x2={S} y2={0} {...p} />
      <line x1={-0.5 * S} y1={-0.45 * S} x2={-0.3 * S} y2={-0.45 * S} {...p} strokeWidth={strokeWidth * 0.7} />
      <line x1={-0.4 * S} y1={-0.55 * S} x2={-0.4 * S} y2={-0.35 * S} {...p} strokeWidth={strokeWidth * 0.7} />
    </g>
  );
}

export function VSourceDepSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  const r = 0.48 * S;
  return (
    <g>
      <line x1={-S} y1={0} x2={-r} y2={0} {...p} />
      <polygon points={`${-r},0 0,${-r} ${r},0 0,${r}`} {...p} />
      <line x1={-0.26 * S} y1={0} x2={-0.08 * S} y2={0} {...p} />
      <line x1={-0.17 * S} y1={-0.09 * S} x2={-0.17 * S} y2={0.09 * S} {...p} />
      <line x1={0.1 * S} y1={0} x2={0.28 * S} y2={0} {...p} />
      <line x1={r} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function DiodeSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  // Triangle points from anode (p1, left) to the cathode bar (p2, right).
  return (
    <g>
      <line x1={-S} y1={0} x2={-0.3 * S} y2={0} {...p} />
      <polygon points={`${-0.3 * S},${-0.35 * S} ${0.3 * S},0 ${-0.3 * S},${0.35 * S}`} {...p} />
      <line x1={0.3 * S} y1={-0.35 * S} x2={0.3 * S} y2={0.35 * S} {...p} />
      <line x1={0.3 * S} y1={0} x2={S} y2={0} {...p} />
    </g>
  );
}

export function GroundSymbol({ stroke, strokeWidth = 2 }: SymbolProps) {
  const p = commonProps(stroke, strokeWidth);
  return (
    <g>
      <line x1={0} y1={-S} x2={0} y2={-0.2 * S} {...p} />
      <line x1={-0.4 * S} y1={-0.2 * S} x2={0.4 * S} y2={-0.2 * S} {...p} />
      <line x1={-0.25 * S} y1={0} x2={0.25 * S} y2={0} {...p} />
      <line x1={-0.1 * S} y1={0.2 * S} x2={0.1 * S} y2={0.2 * S} {...p} />
    </g>
  );
}

export const SYMBOLS: Record<string, (props: SymbolProps) => ReactElement> = {
  resistor: ResistorSymbol,
  capacitor: CapacitorSymbol,
  inductor: InductorSymbol,
  vsource_dc: VSourceDcSymbol,
  vsource_ac: VSourceAcSymbol,
  battery: BatterySymbol,
  vsource_dep: VSourceDepSymbol,
  diode: DiodeSymbol,
  ground: GroundSymbol,
};
