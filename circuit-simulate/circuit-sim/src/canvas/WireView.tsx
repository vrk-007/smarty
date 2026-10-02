import { GRID_SIZE, orthogonalPath, routedPath } from "../utils/geometry";
import type { WireRoute } from "../types/circuit";

interface Props {
  points: { x: number; y: number }[]; // grid units, already resolved
  /** Outward direction of each end's pin, if it is attached to one. */
  dirs?: ({ x: number; y: number } | undefined)[];
  selected: boolean;
  route?: WireRoute;
  /** Called with the axis a drag on the grabbed segment should move along. */
  onPointerDown: (e: React.PointerEvent, dragAxis?: "x" | "y") => void;
}

export function WireView({ points, dirs, selected, route, onPointerDown }: Props) {
  if (points.length < 2) return null;
  const [a, b] = points;
  const grid = route
    ? routedPath(a, b, dirs?.[0], dirs?.[1], route)
    : orthogonalPath(a, b, dirs?.[0], dirs?.[1]);
  const routed = grid.map((p) => ({
    x: p.x * GRID_SIZE,
    y: p.y * GRID_SIZE,
  }));
  const d = routed.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <g>
      {/* wide invisible hit target, since the visible trace is thin */}
      {routed.slice(1).map((p, i) => {
        const q = routed[i];
        // horizontal segment drags up/down, vertical drags left/right
        const axis = q.y === p.y ? "y" : "x";
        return (
          <line
            key={i}
            x1={q.x}
            y1={q.y}
            x2={p.x}
            y2={p.y}
            stroke="transparent"
            strokeWidth={14}
            onPointerDown={(e) => onPointerDown(e, axis)}
            style={{ cursor: axis === "y" ? "ns-resize" : "ew-resize" }}
          />
        );
      })}
      <path
        d={d}
        stroke={selected ? "var(--amber)" : "var(--phosphor)"}
        strokeWidth={selected ? 2.5 : 2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
      />
    </g>
  );
}
