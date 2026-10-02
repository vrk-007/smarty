import { useRef } from "react";
import { useCircuitStore } from "../store/circuitStore";
import type { JsonNetlist } from "../utils/loadNetlistJson";
import type { ViewMode } from "../App";

interface ToolbarProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  drawing: boolean;
  onDrawClick: () => void;
  onLoadImageClick: () => void;
}

export function Toolbar({ viewMode, onViewModeChange, drawing, onDrawClick, onLoadImageClick }: ToolbarProps) {
  const clearAll = useCircuitStore((s) => s.clearAll);
  const loadNetlist = useCircuitStore((s) => s.loadNetlist);
  const netlistRaw = useCircuitStore((s) => s.netlistRaw);
  const componentCount = useCircuitStore((s) => s.components.length);
  const wireCount = useCircuitStore((s) => s.wires.length);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleLoadClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string) as JsonNetlist;

        if (!json.components || !Array.isArray(json.components)) {
          alert("Invalid netlist file: missing \"components\" array.");
          return;
        }

        if (
          componentCount > 0 &&
          !confirm("Loading a new netlist will replace the current schematic. Continue?")
        ) {
          return;
        }

        const skipped = loadNetlist(json);

        if (skipped.length > 0) {
          alert(
            `Netlist loaded.\n\nThe following components are not yet supported in the canvas and were skipped:\n  ${skipped.join(", ")}\n\n` +
            `Supported types: Resistor, Capacitor, Inductor, Voltage (DC/AC), Ground.`
          );
        }
      } catch {
        alert("Failed to parse netlist file. Make sure it is valid JSON.");
      } finally {
        // Reset so the same file can be loaded again if needed.
        e.target.value = "";
      }
    };
    reader.readAsText(file);
  }

  return (
    <>
      <div className="brand">
        <span className="brand-mark">
          NET<span>SCOPE</span>
        </span>
        <span className="brand-sub">schematic capture</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span className="hint-text">
          {componentCount} part{componentCount === 1 ? "" : "s"} · {wireCount} wire
          {wireCount === 1 ? "" : "s"}
        </span>

        {/* View mode toggle ─────────────────────────────────────────── */}
        {netlistRaw && (
          <div className="view-toggle" role="group" aria-label="View mode">
            <button
              id="view-toggle-canvas"
              className={`view-toggle-btn${viewMode === "canvas" ? " active" : ""}`}
              onClick={() => onViewModeChange("canvas")}
              title="SVG schematic canvas"
            >
              Canvas
            </button>
            <button
              id="view-toggle-circuitjs"
              className={`view-toggle-btn${viewMode === "circuitjs" ? " active" : ""}`}
              onClick={() => onViewModeChange("circuitjs")}
              title="Interactive CircuitJS simulation"
            >
              CircuitJS
            </button>
          </div>
        )}

        {/* Hidden file input for JSON netlist */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />

        <button
          className="btn btn-load"
          onClick={onDrawClick}
          disabled={drawing}
          title="Sketch a circuit and let the model generate the schematic"
        >
          Draw Circuit
        </button>

        <button
          className="btn btn-load"
          onClick={onLoadImageClick}
          disabled={drawing}
          title="Generate the schematic from a photo or scan of a circuit"
        >
          Load Image
        </button>

        <button
          className="btn btn-load"
          onClick={handleLoadClick}
          title="Load a JSON netlist file"
        >
          Load Netlist
        </button>

        <button
          className="btn"
          onClick={() => {
            if (componentCount === 0 || confirm("Clear the whole schematic?")) clearAll();
          }}
        >
          Clear
        </button>
      </div>

    </>
  );
}
