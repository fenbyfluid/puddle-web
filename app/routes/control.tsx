import { useEffect, useState, useRef, useCallback } from "react";
import type { Route } from "./+types/control";
import type {
  ClientMessage,
  CoreMessage,
  CoreState,
  MotionCommand,
  SavedSetMetadata,
  MotionAction,
} from "~/bindings";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Control - Puddle" },
  ];
}

export default function Control() {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [controllerId, setControllerId] = useState<string | null>(null);
  const [state, setState] = useState<CoreState | null>(null);
  const [activeSet, setActiveSet] = useState<{ version: number; commands: MotionCommand[] } | null>(null);
  const [savedSets, setSavedSets] = useState<SavedSetMetadata[]>([]);
  const [writeAccessHolder, setWriteAccessHolder] = useState<string | null>(null);
  const [seq, setSeq] = useState(1);

  const seqRef = useRef(1);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<number, { resolve: (v: any) => void; reject: (r: any) => void }>>(new Map());
  const stateRef = useRef<CoreState | null>(null);
  const rafRef = useRef<number | null>(null);

  // https://github.com/microsoft/TypeScript/issues/53696
  // https://davidgarciasantes.medium.com/understanding-why-omit-and-pick-fail-with-union-types-5ca3d754a7cb
  type DistributiveOmit<T, K extends keyof any> = T extends any
    ? Omit<T, K>
    : never;

  const send = useCallback((msg: DistributiveOmit<ClientMessage, "seq">): Promise<CoreMessage> => {
    return new Promise((resolve, reject) => {
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        const currentSeq = seqRef.current++;
        const fullMsg = { ...msg, seq: currentSeq } as ClientMessage;
        try {
          socketRef.current.send(JSON.stringify(fullMsg));
          pendingRef.current.set(currentSeq, { resolve, reject });
          setSeq(seqRef.current);
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error("WebSocket not open"));
      }
    });
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setSocket(ws);
    };

    ws.onmessage = (event) => {
      const msg: CoreMessage = JSON.parse(event.data);

      if ('seq' in msg && typeof msg.seq === 'number') {
        if (pendingRef.current.has(msg.seq)) {
          const { resolve } = pendingRef.current.get(msg.seq)!;
          pendingRef.current.delete(msg.seq);
          resolve(msg);
        }
      }

      switch (msg.type) {
        case "connected":
          setControllerId(msg.controller_id);
          // initialize both the ref (for high-rate updates) and visible state once
          stateRef.current = msg.state;
          setState(msg.state);
          setWriteAccessHolder(msg.state.write_access_holder);

          // start requestAnimationFrame loop to render buffered state at display rate
          if (rafRef.current == null) {
            const tick = () => {
              const s = stateRef.current;
              if (s) setState(s);
              rafRef.current = requestAnimationFrame(tick);
            };
            rafRef.current = requestAnimationFrame(tick);
          }

          send({ type: "get_command_set", set: null });
          send({ type: "list_saved_sets" });
          break;
        case "state":
          // Buffer the high-rate state updates into a ref to avoid re-rendering
          stateRef.current = { ...(stateRef.current ?? {}), ...msg } as CoreState;
          break;
        case "command_set":
          if (msg.set === null) {
            setActiveSet({ version: msg.version, commands: msg.commands });
          }
          break;
        case "saved_set_list":
          setSavedSets(msg.sets);
          break;
        case "write_access_result":
          if (msg.granted) {
            setWriteAccessHolder(msg.holder);
          }
          break;
        case "write_access_changed":
          setWriteAccessHolder(msg.holder);
          break;
        case "command_set_changed":
          send({ type: "get_command_set", set: null });
          break;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setSocket(null);
      // stop RAF loop and clear buffered state
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      stateRef.current = null;
    };

    return () => {
      ws.close();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      stateRef.current = null;
      // reject any pending promises since socket is closing
      for (const [k, { reject }] of pendingRef.current.entries()) {
        reject(new Error("WebSocket closed"));
        pendingRef.current.delete(k);
      }
    };
  }, [send]);

  const isWriter = controllerId !== null && writeAccessHolder === controllerId;

  const togglePower = () => {
    if (!state) return;
    send({ type: "set_drive_power", enabled: state.drive_state === "off" || state.drive_state === "errored" });
  };

  const motionControl = (action: MotionAction) => {
    send({ type: "set_motion_state", action });
  };

  const requestWriteAccess = () => send({ type: "request_write_access" });
  const releaseWriteAccess = () => send({ type: "release_write_access" });
  const acknowledgeError = () => send({ type: "acknowledge_error" });

  const POS_SCALE = 10000.0;
  const VEL_SCALE = 1000000.0;
  const ACC_SCALE = 100000.0;

  const fieldToScale: Record<keyof MotionCommand, number> = {
    position: POS_SCALE,
    velocity: VEL_SCALE,
    acceleration: ACC_SCALE,
    deceleration: ACC_SCALE,
  };

  const updateCommand = (index: number, field: keyof MotionCommand, value: string) => {
    if (!activeSet) return;
    const numValue = parseFloat(value);
    if (isNaN(numValue)) return;

    // Convert display value back to raw units
    const rawValue = Math.round(numValue * fieldToScale[field]);

    send({
      type: "update_command",
      index,
      fields: { [field]: rawValue }
    });
  };

  const saveActiveSetAs = (name: string) => {
    if (!activeSet) return;
    send({
      type: "upsert_command_set",
      set: name,
      commands: activeSet.commands
    });
    setTimeout(() => send({ type: "list_saved_sets" }), 500);
  };

  const loadSavedSet = (name: string) => {
    send({
      type: "get_command_set",
      set: name
    });
  };

  const applyToActive = (commands: MotionCommand[]) => {
    send({
      type: "upsert_command_set",
      set: null,
      commands
    });
  };

  const addCommand = () => {
    if (!activeSet) return;
    const newCommands = [...activeSet.commands, { position: 0, velocity: 0, acceleration: 0, deceleration: 0 }];
    applyToActive(newCommands);
  };

  const deleteSet = (name: string) => {
    send({
      type: "delete_command_set",
      set: name
    });
    setTimeout(() => send({ type: "list_saved_sets" }), 500);
  };

  return (
    <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8 w-full space-y-6 bg-gray-50 min-h-screen">
      {/* Header / Connection Status */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white p-4 rounded-xl shadow-sm border border-gray-200">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Puddle Control</h1>
          <div className="flex items-center mt-1 space-x-4 text-sm">
            <span className={`flex items-center ${connected ? "text-green-600" : "text-red-600"}`}>
              <span className={`w-2 h-2 rounded-full mr-2 ${connected ? "bg-green-600 animate-pulse" : "bg-red-600"}`}></span>
              {connected ? "Connected" : "Disconnected"}
            </span>
            {controllerId && <span className="text-gray-500">ID: {controllerId}</span>}
          </div>
        </div>
        <div className="mt-4 sm:mt-0 flex items-center space-x-2">
          {isWriter ? (
            <button
              onClick={releaseWriteAccess}
              className="px-4 py-2 bg-amber-100 text-amber-800 rounded-lg font-medium hover:bg-amber-200 transition-colors border border-amber-200"
            >
              Release Write Access
            </button>
          ) : (
            <button
              onClick={requestWriteAccess}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50"
              disabled={!connected || !!writeAccessHolder}
            >
              {writeAccessHolder ? `Controlled by ${writeAccessHolder}` : "Request Write Access"}
            </button>
          )}
        </div>
      </div>

      {!state ? (
        <div className="flex items-center justify-center h-64 bg-white rounded-xl border border-gray-200 shadow-sm">
          <div className="text-gray-400 flex flex-col items-center">
            <div className="w-8 h-8 border-4 border-gray-200 border-t-blue-500 rounded-full animate-spin mb-4"></div>
            Waiting for system state...
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Controls & Live State */}
          <div className="lg:col-span-2 space-y-6">
            {/* Drive Controls */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-semibold text-gray-900">Drive Control</h2>
                <div className={`px-3 py-1 rounded-full text-sm font-bold uppercase tracking-wider ${
                  state.drive_state === 'moving' ? 'bg-green-100 text-green-700' :
                  state.drive_state === 'errored' ? 'bg-red-100 text-red-700 animate-pulse' :
                  'bg-gray-100 text-gray-700'
                }`}>
                  {state.drive_state}
                </div>
              </div>

              <div className="flex flex-wrap gap-4">
                <button
                  disabled={!isWriter || (state.drive_state !== 'off' && state.drive_state !== 'errored' && state.drive_state !== 'preparing')}
                  onClick={togglePower}
                  className="flex-1 min-w-30 py-3 bg-gray-900 text-white rounded-xl font-bold hover:bg-black transition-colors disabled:opacity-30"
                >
                  Power On
                </button>
                <button
                  disabled={!isWriter || state.drive_state === 'off'}
                  onClick={togglePower}
                  className="flex-1 min-w-30 py-3 bg-white text-red-600 border-2 border-red-100 rounded-xl font-bold hover:bg-red-50 transition-colors disabled:opacity-30"
                >
                  Power Off
                </button>

                {state.drive_state === 'errored' && (
                  <button
                    disabled={!isWriter}
                    onClick={acknowledgeError}
                    className="flex-1 min-w-30 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-colors shadow-lg shadow-red-200"
                  >
                    Acknowledge Error
                  </button>
                )}
              </div>

              <div className="grid grid-cols-3 gap-4 mt-6">
                <button
                  disabled={!isWriter || state.drive_state !== 'paused'}
                  onClick={() => motionControl('start')}
                  className="py-4 bg-green-500 text-white rounded-xl font-bold hover:bg-green-600 transition-all disabled:opacity-30 shadow-md shadow-green-100"
                >
                  START
                </button>
                <button
                  disabled={!isWriter || state.drive_state !== 'moving'}
                  onClick={() => motionControl('pause')}
                  className="py-4 bg-amber-500 text-white rounded-xl font-bold hover:bg-amber-600 transition-all disabled:opacity-30 shadow-md shadow-amber-100"
                >
                  PAUSE
                </button>
                <button
                  disabled={!isWriter || (state.drive_state !== 'moving' && state.drive_state !== 'paused')}
                  onClick={() => motionControl('stop')}
                  className="py-4 bg-gray-200 text-gray-800 rounded-xl font-bold hover:bg-gray-300 transition-all disabled:opacity-30"
                >
                  STOP
                </button>
              </div>
            </div>

            {/* Live Telemetry */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Actual Pos", value: (state.actual_position / POS_SCALE).toFixed(3), unit: "mm" },
                { label: "Demand Pos", value: (state.demand_position / POS_SCALE).toFixed(3), unit: "mm" },
                { label: "Velocity", value: (state.demand_velocity / VEL_SCALE).toFixed(3), unit: "m/s" },
                { label: "Accel", value: (state.demand_acceleration / ACC_SCALE).toFixed(3), unit: "m/s²" },
                { label: "Current", value: (state.current_draw / 1000).toFixed(2), unit: "A" },
                { label: "Drive Temp", value: (state.drive_temperature / 10).toFixed(2), unit: "°C" },
                { label: "Motor Temp", value: ((state.motor_temperature * (50 / 51)) - 50).toFixed(2), unit: "°C" },
                { label: "Cmd Index", value: state.active_command_index, unit: "" },
              ].map((item, idx) => (
                <div key={idx} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">{item.label}</div>
                  <div className="text-xl font-mono font-bold text-gray-900">
                    {item.value}<span className="text-xs ml-1 text-gray-400 font-normal">{item.unit}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Warnings & Errors */}
            {(state.error_code || state.warnings.length > 0) && (
              <div className="space-y-3">
                {state.error_code && (
                  <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-r-xl">
                    <div className="flex">
                      <div className="shrink-0">
                        <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                        </svg>
                      </div>
                      <div className="ml-3">
                        <p className="text-sm font-bold text-red-800 uppercase">Error: {state.error_code}</p>
                      </div>
                    </div>
                  </div>
                )}
                {state.warnings.map((warning, i) => (
                  <div key={i} className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-r-xl">
                    <div className="flex">
                      <div className="shrink-0">
                        <svg className="h-5 w-5 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                        </svg>
                      </div>
                      <div className="ml-3">
                        <p className="text-sm text-amber-800">{warning}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Active Command Set Editor */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="p-4 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
                <h2 className="font-semibold text-gray-900">Active Command Set (v{activeSet?.version ?? 0})</h2>
                <div className="flex space-x-2">
                   <button
                    onClick={() => {
                      const name = prompt("Enter name for command set:");
                      if (name) saveActiveSetAs(name);
                    }}
                    className="px-3 py-1 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                  >
                    Save As...
                  </button>
                  <button
                    disabled={!isWriter}
                    onClick={addCommand}
                    className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    Add Command
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">#</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Position (mm)</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Velocity (m/s)</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Accel (m/s²)</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Decel (m/s²)</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {activeSet?.commands.map((cmd, i) => (
                      <tr key={`${i}-${activeSet.version}`} className={state.active_command_index === i ? "bg-blue-50" : ""}>
                        <td className="px-4 py-2 text-sm font-mono text-gray-500">{i}</td>
                        {['position', 'velocity', 'acceleration', 'deceleration'].map((field) => (
                          <td key={field} className="px-4 py-2">
                            <input
                              type="number"
                              step="0.001"
                              disabled={!isWriter}
                              defaultValue={cmd[field as keyof MotionCommand] / fieldToScale[field as keyof MotionCommand]}
                              onBlur={(e) => updateCommand(i, field as keyof MotionCommand, e.target.value)}
                              className="w-full px-2 py-1 text-sm border border-gray-200 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:bg-transparent disabled:border-transparent font-mono"
                            />
                          </td>
                        ))}
                        <td className="px-4 py-2 text-right">
                          <button
                            disabled={!isWriter}
                            onClick={() => {
                              const newCmds = activeSet.commands.filter((_, idx) => idx !== i);
                              applyToActive(newCmds);
                            }}
                            className="text-gray-400 hover:text-red-600 disabled:opacity-0"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                    {(!activeSet || activeSet.commands.length === 0) && (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-gray-400 italic">No commands in set</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Saved Sets Library */}
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">Saved Sets</h2>
                <button
                  onClick={() => send({ type: "list_saved_sets" })}
                  className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                >
                  Refresh
                </button>
              </div>
              <div className="space-y-3">
                {savedSets.map((set) => (
                  <div key={set.name} className="p-3 border border-gray-100 rounded-lg hover:bg-gray-50 group">
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="font-bold text-gray-900">{set.name}</div>
                        <div className="text-xs text-gray-500">v{set.version} • {new Date(set.saved_at).toLocaleDateString()}</div>
                      </div>
                      <div className="flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => loadSavedSet(set.name)}
                          className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                          title="Load & Preview"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        </button>
                        <button
                          disabled={!isWriter}
                          onClick={() => {
                            if (confirm(`Replace active set with "${set.name}"?`)) {
                              // Fetch the saved set, then apply it to the active set when received.
                              send({ type: "get_command_set", set: set.name })
                                .then((resp) => {
                                  if (resp.type === "command_set") {
                                    applyToActive(resp.commands);
                                  } else {
                                    alert("Unexpected response when fetching saved set");
                                  }
                                })
                                .catch((err) => {
                                  console.error("Failed to fetch saved set:", err);
                                  alert("Failed to fetch saved set");
                                });
                            }
                          }}
                          className="p-1 text-green-600 hover:bg-green-50 rounded disabled:opacity-0"
                          title="Apply to Active"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Delete saved set "${set.name}"?`)) deleteSet(set.name);
                          }}
                          className="p-1 text-red-600 hover:bg-red-50 rounded disabled:opacity-0"
                          title="Delete"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {savedSets.length === 0 && (
                  <div className="text-center py-8 text-gray-400 italic border-2 border-dashed border-gray-100 rounded-lg">
                    No saved sets
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
              <h3 className="font-semibold text-gray-900 mb-2">Protocol Debug</h3>
              <div className="text-xs font-mono text-gray-500 space-y-1">
                <div>Seq: {seq}</div>
                <div>Writer: {writeAccessHolder || "None"}</div>
                <div>My ID: {controllerId || "..."}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
