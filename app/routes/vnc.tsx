import { useCallback, useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import type { Route } from "./+types/vnc";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "VNC - Puddle" },
  ];
}

export default function VNC() {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const [reconnectKey, setReconnectKey] = useState(0);

  const connect = useCallback(() => {
    if (!containerRef.current) return;

    setStatus("connecting");

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/websockify`;

    const rfb = new RFB(containerRef.current, url);
    rfbRef.current = rfb;

    rfb.resizeSession = true;
    rfb.scaleViewport = true;

    let hasDisconnected = false;
    const handleConnect = () => setStatus("connected");
    const handleDisconnect = (e: CustomEvent<{ clean: boolean }>) => {
      hasDisconnected = true;
      setStatus(e.detail.clean ? "disconnected" : "error");
    };

    rfb.addEventListener("connect", handleConnect);
    rfb.addEventListener("disconnect", handleDisconnect);

    return () => {
      rfb.removeEventListener("connect", handleConnect);
      rfb.removeEventListener("disconnect", handleDisconnect);

      if (!hasDisconnected) {
        rfb.disconnect();
      }

      rfbRef.current = null;
    };
  }, []);

  useEffect(() => {
    return connect();
  }, [connect, reconnectKey]);

  const handleReconnect = () => {
    setReconnectKey(prev => prev + 1);
  };

  const getStatusText = () => {
    switch (status) {
      case "connecting":
        return "Connecting ...";
      case "disconnected":
        return "Disconnected";
      case "error":
        return "Connection Error";
      default:
        return null;
    }
  };

  return (
    <div className="flex-grow bg-[#282828] overflow-hidden flex items-center justify-center relative">
      <div ref={containerRef} className="absolute inset-0"/>

      {status !== "connected" && (
        <div
          className="relative z-10 flex flex-col items-center gap-6 p-8 bg-black/40 backdrop-blur-md rounded-2xl text-white text-lg text-center shadow-2xl border border-white/10">
          {status === "connecting" && (
            <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin"/>
          )}

          <div className="flex flex-col gap-1">
            <div className="font-semibold">{getStatusText()}</div>
            {status !== "connecting" && (
              <div className="text-sm text-white/60">
                The connection to the VNC server was lost.
              </div>
            )}
          </div>

          {status !== "connecting" && (
            <button
              onClick={handleReconnect}
              className="px-6 py-2 bg-white text-black rounded-full font-medium hover:bg-white/90 transition-colors active:scale-95"
            >
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
