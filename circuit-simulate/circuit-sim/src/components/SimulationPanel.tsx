import { useMemo, useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { buildNetlist } from "../domain/netlist";
import type { AnalysisMode } from "../domain/simulationConfig";

export function SimulationPanel() {
  const components = useCircuitStore((s) => s.components);
  const wires = useCircuitStore((s) => s.wires);
  const simConfig = useCircuitStore((s) => s.simConfig);
  const setSimConfig = useCircuitStore((s) => s.setSimConfig);
  const simStatus = useCircuitStore((s) => s.simStatus);
  const simResult = useCircuitStore((s) => s.simResult);
  const simError = useCircuitStore((s) => s.simError);
  const runSimulate = useCircuitStore((s) => s.runSimulate);

  const [showPayload, setShowPayload] = useState(false);

  const netlist = useMemo(() => buildNetlist(components, wires), [components, wires]);

  const groundCount = components.filter((c) => c.kind === "ground").length;
  const canSimulate = components.length > 0 && groundCount > 0;

  return (
    <div className="panel-section panel-section-grow">
      <div className="panel-title">Analysis</div>

      <label className="field">
        <span className="field-label">Type</span>
        <select
          className="field-input"
          value={simConfig.mode}
          onChange={(e) =>
            setSimConfig({ ...simConfig, mode: e.target.value as AnalysisMode })
          }
        >
          <option value="tran">Transient</option>
          <option value="dc">DC Operating Point</option>
          <option value="ac">AC Sweep</option>
        </select>
      </label>

      {simConfig.mode === "tran" && (
        <>
          <label className="field">
            <span className="field-label">Step (s)</span>
            <input
              className="field-input"
              value={simConfig.tran.stepSeconds}
              onChange={(e) =>
                setSimConfig({
                  ...simConfig,
                  tran: { ...simConfig.tran, stepSeconds: Number(e.target.value) || 0 },
                })
              }
            />
          </label>
          <label className="field">
            <span className="field-label">Stop (s)</span>
            <input
              className="field-input"
              value={simConfig.tran.stopSeconds}
              onChange={(e) =>
                setSimConfig({
                  ...simConfig,
                  tran: { ...simConfig.tran, stopSeconds: Number(e.target.value) || 0 },
                })
              }
            />
          </label>
        </>
      )}

      {simConfig.mode === "ac" && (
        <>
          <label className="field">
            <span className="field-label">Start (Hz)</span>
            <input
              className="field-input"
              value={simConfig.ac.startHz}
              onChange={(e) =>
                setSimConfig({ ...simConfig, ac: { ...simConfig.ac, startHz: Number(e.target.value) || 0 } })
              }
            />
          </label>
          <label className="field">
            <span className="field-label">Stop (Hz)</span>
            <input
              className="field-input"
              value={simConfig.ac.stopHz}
              onChange={(e) =>
                setSimConfig({ ...simConfig, ac: { ...simConfig.ac, stopHz: Number(e.target.value) || 0 } })
              }
            />
          </label>
        </>
      )}

      {!canSimulate && (
        <p className="hint-text warn">
          {components.length === 0
            ? "Place at least one component to simulate."
            : "Add a ground reference — every circuit needs one node tied to 0V."}
        </p>
      )}

      <button
        className="btn btn-primary"
        disabled={!canSimulate || simStatus === "running"}
        onClick={runSimulate}
      >
        {simStatus === "running" ? "Simulating…" : "Simulate"}
      </button>

      <button className="btn-link" onClick={() => setShowPayload((v) => !v)}>
        {showPayload ? "Hide" : "Show"} request JSON
      </button>

      {showPayload && (
        <pre className="json-preview">
          {JSON.stringify({ netlist, analysis: simConfig }, null, 2)}
        </pre>
      )}

      {simStatus === "error" && <div className="result-box result-error">{simError}</div>}
      {simStatus === "done" && simResult && (
        <div className="result-box result-ok">
          {simResult.message ?? "Simulation complete."}
          {simResult.traces && (
            <div className="hint-text">
              Traces: {Object.keys(simResult.traces).join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
