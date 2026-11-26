import { useFlowStore } from './store';
import { RunHistoryView } from './views/RunHistoryView';
import { useEffect, useState } from "react";
import Home from "./Home";
import { connectToRunner, disconnectRunner } from "./socket";
import init, { get_engine_version } from "workspace_engine";

export default function App() {
  return window.location.pathname === '/run-reports' ? <RunHistoryView /> : <RunnerApp />;
}

function RunnerApp() {
  const stopped = useFlowStore(state => state.dashboardStopped);
  const [engineStatus, setEngineStatus] = useState<string>(
    "Initialising Native Engine...",
  );

  useEffect(() => {
    connectToRunner();

    const loadNativeEngine = async () => {
      try {
        // Initialise the WebAssembly memory bridge globally
        await init();

        // Fetch the stateless version string
        const version = get_engine_version();

        setEngineStatus(
          `Secure Connection: ${version} | Core memory ready for Workspace allocation`,
        );
        console.log("Native Engine Core Loaded Successfully");
      } catch (error) {
        console.error("Failed to load native engine:", error);
        setEngineStatus("Security Alert: Failed to load Native Engine Core");
      }
    };

    loadNativeEngine();

    return () => {
      disconnectRunner();
    };
  }, []);

  if (stopped) return <main role="status" style={{ padding: '2rem' }}>Flowstride has stopped. You can close this tab.</main>;
  return (
    <>
      <div
        style={{
          backgroundColor: "#1e1e1e",
          color: "#00ff00",
          padding: "8px",
          textAlign: "center",
          fontFamily: "monospace",
        }}
      >
        {engineStatus}
      </div>
      <Home />
    </>
  );
}
