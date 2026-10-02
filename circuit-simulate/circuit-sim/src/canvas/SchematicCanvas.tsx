import { useCallback, useEffect, useRef, useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { getDef } from "../domain/componentDefs";
import { GRID_SIZE, pinDirection, resolvePinWorld, snap } from "../utils/geometry";
import { useCanvasView } from "./useCanvasView";
import { ComponentView } from "./ComponentView";
import { WireView } from "./WireView";
import type { ComponentKind, PinRef } from "../types/circuit";

const DOT = 1.5;

export function SchematicCanvas() {
  const svgRef = useRef<SVGSVGElement>(null);
  const { view, screenToGrid, beginPan, updatePan, endPan, zoomAt } =
    useCanvasView(svgRef);

  const components = useCircuitStore((s) => s.components);
  const wires = useCircuitStore((s) => s.wires);
  const rawWireSegments = useCircuitStore((s) => s.rawWireSegments);
  const rawJunctions = useCircuitStore((s) => s.rawJunctions);
  const selection = useCircuitStore((s) => s.selection);
  const pendingWire = useCircuitStore((s) => s.pendingWire);
  const select = useCircuitStore((s) => s.select);
  const addComponent = useCircuitStore((s) => s.addComponent);
  const moveComponent = useCircuitStore((s) => s.moveComponent);
  const setWireRoute = useCircuitStore((s) => s.setWireRoute);
  const rotateComponent = useCircuitStore((s) => s.rotateComponent);
  const mirrorComponent = useCircuitStore((s) => s.mirrorComponent);
  const deleteSelected = useCircuitStore((s) => s.deleteSelected);
  const startWire = useCircuitStore((s) => s.startWire);
  const updateWireCursor = useCircuitStore((s) => s.updateWireCursor);
  const finishWire = useCircuitStore((s) => s.finishWire);
  const cancelWire = useCircuitStore((s) => s.cancelWire);

  const [hoveredPin, setHoveredPin] = useState<{ componentId: string; pinId: string } | null>(
    null
  );
  const dragging = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const wireDrag = useRef<{ id: string; axis: "x" | "y" } | null>(null);
  const panning = useRef(false);
  // Set to true by a pin's onPointerUp handler so the SVG-level onPointerUp
  // knows NOT to cancel an in-progress wire (the pin already finished it).
  const wireFinalizedByPin = useRef(false);

  // --- keyboard shortcuts: delete / rotate / mirror the selection ---
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Delete" || e.key === "Backspace") {
        if ((e.target as HTMLElement)?.tagName === "INPUT") return;
        deleteSelected();
      } else if (e.key.toLowerCase() === "r" && selection?.type === "component") {
        rotateComponent(selection.id);
      } else if (e.key.toLowerCase() === "m" && selection?.type === "component") {
        mirrorComponent(selection.id);
      } else if (e.key === "Escape") {
        cancelWire();
        select(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, deleteSelected, rotateComponent, mirrorComponent, cancelWire, select]);

  // --- drop a new component from the palette ---
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData("application/x-component-kind") as ComponentKind;
      if (!kind) return;
      const { x, y } = screenToGrid(e.clientX, e.clientY);
      addComponent(kind, x, y);
    },
    [screenToGrid, addComponent]
  );

  // --- background: pan on drag, deselect on click ---
  const onBackgroundPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 2 || e.button === 1) {
        panning.current = true;
        beginPan(e.clientX, e.clientY);
        return;
      }
      select(null);
    },
    [beginPan, select]
  );

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (panning.current) {
        updatePan(e.clientX, e.clientY);
        return;
      }
      if (wireDrag.current) {
        const { x, y } = screenToGrid(e.clientX, e.clientY);
        const { id, axis } = wireDrag.current;
        setWireRoute(id, { axis, value: snap(axis === "y" ? y : x) });
        return;
      }
      if (dragging.current) {
        const { x, y } = screenToGrid(e.clientX, e.clientY);
        moveComponent(dragging.current.id, x - dragging.current.offsetX, y - dragging.current.offsetY);
        return;
      }
      if (pendingWire) {
        const { x, y } = screenToGrid(e.clientX, e.clientY);
        updateWireCursor({ x: snap(x), y: snap(y) });
      }
    },
    [screenToGrid, moveComponent, setWireRoute, pendingWire, updateWireCursor, updatePan]
  );

  const onSvgPointerUp = useCallback(() => {
    panning.current = false;
    endPan();
    dragging.current = null;
    wireDrag.current = null;
    if (pendingWire) {
      if (wireFinalizedByPin.current) {
        // A pin's onPointerUp already called finishWire — don't cancel.
        wireFinalizedByPin.current = false;
      } else {
        // Released over empty space: cancel the wire.
        cancelWire();
      }
    }
  }, [endPan, pendingWire, cancelWire]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      zoomAt(e.clientX, e.clientY, e.deltaY);
    },
    [zoomAt]
  );

  // --- component body drag-to-move ---
  const startBodyDrag = useCallback(
    (componentId: string) => (e: React.PointerEvent) => {
      e.stopPropagation();
      const comp = components.find((c) => c.id === componentId);
      if (!comp) return;
      select({ type: "component", id: componentId });
      const { x, y } = screenToGrid(e.clientX, e.clientY);
      dragging.current = { id: componentId, offsetX: x - comp.x, offsetY: y - comp.y };
    },
    [components, screenToGrid, select]
  );

  // --- pin drag-to-wire ---
  const onPinPointerDown = useCallback(
    (pin: PinRef, e: React.PointerEvent) => {
      if (pendingWire) {
        // Second click on a destination pin while already drawing a wire:
        // finish the wire on pointer-down (click mode).
        e.stopPropagation();
        wireFinalizedByPin.current = true;
        finishWire(pin);
        return;
      }
      // Start a new wire from this pin.
      const { x, y } = screenToGrid(e.clientX, e.clientY);
      startWire(pin, { x: snap(x), y: snap(y) });
    },
    [pendingWire, screenToGrid, startWire, finishWire]
  );

  const onPinPointerUp = useCallback(
    (pin: PinRef) => (e: React.PointerEvent) => {
      if (!pendingWire) return; // no wire in progress — ignore
      e.stopPropagation();
      wireFinalizedByPin.current = true;
      finishWire(pin);
    },
    [pendingWire, finishWire]
  );

  const componentPinWorld = (componentId: string, pinId: string) => {
    const comp = components.find((c) => c.id === componentId);
    if (!comp) return { x: 0, y: 0 };
    const def = getDef(comp.kind);
    const pinDef = def.pins.find((p) => p.id === pinId)!;
    return resolvePinWorld(comp, pinDef);
  };

  const componentPinDir = (componentId: string, pinId: string) => {
    const comp = components.find((c) => c.id === componentId);
    const pinDef = comp && getDef(comp.kind).pins.find((p) => p.id === pinId);
    return comp && pinDef ? pinDirection(comp, pinDef) : undefined;
  };

  const isPinConnected = (componentId: string, pinId: string) =>
    wires.some(
      (w) =>
        (w.from.componentId === componentId && w.from.pinId === pinId) ||
        (w.to.componentId === componentId && w.to.pinId === pinId)
    );

  return (
    <svg
      ref={svgRef}
      width="100%"
      height="100%"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onSvgPointerMove}
      onPointerUp={onSvgPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
      style={{ display: "block", background: "var(--bg-canvas)", touchAction: "none" }}
    >
      <defs>
        <pattern id="grid-dots" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
          <circle cx={GRID_SIZE / 2} cy={GRID_SIZE / 2} r={DOT} fill="var(--line-grid)" />
        </pattern>
      </defs>

      <g transform={`translate(${view.panX}, ${view.panY}) scale(${view.zoom})`}>
        <rect x={-4000} y={-4000} width={8000} height={8000} fill="url(#grid-dots)" />

        {/* ── Raw wire segments from loaded netlist JSON (pixel geometry) ──────── */}
        {rawWireSegments.length > 0 && (
          <g
            className="raw-wires-layer"
            pointerEvents="none"
            opacity={wires.length > 0 ? 0.45 : 1}
          >
            {rawWireSegments.map((seg, i) => (
              <line
                key={i}
                x1={seg.x1 * GRID_SIZE}
                y1={seg.y1 * GRID_SIZE}
                x2={seg.x2 * GRID_SIZE}
                y2={seg.y2 * GRID_SIZE}
                stroke="var(--phosphor)"
                strokeWidth={2}
                strokeLinecap="round"
              />
            ))}
            {rawJunctions.map((jct, i) => (
              <circle
                key={i}
                cx={jct.x * GRID_SIZE}
                cy={jct.y * GRID_SIZE}
                r={4}
                fill="var(--phosphor)"
              />
            ))}
          </g>
        )}

        {wires.map((w) => (
          <WireView
            key={w.id}
            points={[
              componentPinWorld(w.from.componentId, w.from.pinId),
              componentPinWorld(w.to.componentId, w.to.pinId),
            ]}
            dirs={[
              componentPinDir(w.from.componentId, w.from.pinId),
              componentPinDir(w.to.componentId, w.to.pinId),
            ]}
            selected={selection?.type === "wire" && selection.id === w.id}
            route={w.route}
            onPointerDown={(e, axis) => {
              e.stopPropagation();
              select({ type: "wire", id: w.id });
              if (axis && e.button === 0) wireDrag.current = { id: w.id, axis };
            }}
          />
        ))}

        {pendingWire && (
          <WireView
            points={[componentPinWorld(pendingWire.from.componentId, pendingWire.from.pinId), pendingWire.cursor]}
            dirs={[componentPinDir(pendingWire.from.componentId, pendingWire.from.pinId)]}
            selected={false}
            onPointerDown={() => {}}
          />
        )}

        {components.map((c) => (
          <ComponentView
            key={c.id}
            component={c}
            selected={selection?.type === "component" && selection.id === c.id}
            hoveredPin={hoveredPin?.componentId === c.id ? hoveredPin.pinId : null}
            onPointerDownBody={startBodyDrag(c.id)}
            onPinPointerDown={(pin, e) => onPinPointerDown(pin, e)}
            onPinPointerUp={(pin, e) => onPinPointerUp(pin)(e)}
            onPinPointerEnter={(pinId) => setHoveredPin({ componentId: c.id, pinId })}
            onPinPointerLeave={() => setHoveredPin(null)}
            isPinConnected={(pinId) => isPinConnected(c.id, pinId)}
          />
        ))}
      </g>
    </svg>
  );
}
