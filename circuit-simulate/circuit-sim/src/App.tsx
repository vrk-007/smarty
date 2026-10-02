import { useState } from "react";
import { Toolbar } from "./components/Toolbar";
import { ComponentPalette } from "./components/ComponentPalette";
import { SchematicCanvas } from "./canvas/SchematicCanvas";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { SimulationPanel } from "./components/SimulationPanel";
import { CircuitJsViewer } from "./components/CircuitJsViewer";
import { DrawCircuitOverlay } from "./components/DrawCircuitOverlay";
import { useCircuitStore } from "./store/circuitStore";

export type ViewMode = "canvas" | "circuitjs";

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const [drawing, setDrawing] = useState(false);
  const [pickImage, setPickImage] = useState(false);
  const netlistRaw = useCircuitStore((s) => s.netlistRaw);
  const sceneVersion = useCircuitStore((s) => s.sceneVersion);

  return (
    <div className="app-shell">
      <div className="app-titlebar">
        <Toolbar
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          drawing={drawing}
          onDrawClick={() => {
            setViewMode("canvas");
            setPickImage(false);
            setDrawing(true);
          }}
          onLoadImageClick={() => {
            setViewMode("canvas");
            setPickImage(true);
            setDrawing(true);
          }}
        />
      </div>
      <div className="app-palette">
        <ComponentPalette />
      </div>
      <div className="app-canvas-area">
        {viewMode === "canvas" ? (
          // Remount per scene so a new circuit starts from a fresh view.
          <SchematicCanvas key={sceneVersion} />
        ) : (
          <CircuitJsViewer netlistJson={netlistRaw} />
        )}
        {drawing && <DrawCircuitOverlay pickImageOnOpen={pickImage} onClose={() => setDrawing(false)} />}
      </div>
      <div className="app-inspector">
        <PropertiesPanel />
        <SimulationPanel />
      </div>
    </div>
  );
}
