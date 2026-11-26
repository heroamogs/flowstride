import { useEffect } from "react";
import {
  Play,
  Square,
  RotateCcw,
  PanelRight,
  PanelRightClose,
  ChevronRight,
} from "lucide-react";
import { useFlowStore } from "../store";
import { sendToRunner } from "../socket";

export const Header = ({ isRightPanelOpen, onToggleRightPanel }: any) => {
  const {
    isRunning,
    activeFiles, pendingPauses, queuedPauses,
    runStatus,
    timer,
    stopExecution,
    incrementTimer,
    activeTestFile,
    browserInfo,
  } = useFlowStore();

  useEffect(() => {
    let interval: any;
    if (isRunning) {
      interval = setInterval(() => {
        incrementTimer();
      }, 1000);
    } else {
      clearInterval(interval);
    }
    return () => clearInterval(interval);
  }, [isRunning, incrementTimer]);

  const paused = Object.values(pendingPauses).some(pause => pause.fileName === activeTestFile);
  const queued = queuedPauses.includes(activeTestFile);
  const handleRun = (selected: boolean) => {
    if (isRunning) return;
    sendToRunner('RERUN_REQ', selected ? { filePath: activeTestFile } : {});
  };

  const handleStop = () => {
    stopExecution();
    sendToRunner("STOP_REQ", {});
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0");
    const secs = (seconds % 60).toString().padStart(2, "0");
    return `00:${mins}:${secs}`;
  };

  return (
    <div
      style={{
        height: "50px",
        minHeight: "50px",
        borderBottom: "1px solid #30363d",
        display: "flex",
        alignItems: "center",
        padding: "0 20px",
        justifyContent: "space-between",
        backgroundColor: "#0d1117",
        flexShrink: 0,
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <span
          style={{ fontWeight: "bold", color: "#7c3aed", fontSize: "14px" }}
        >
          Flowstride
        </span>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            color: "#8b949e",
            fontSize: "12px",
          }}
        >
          <span>E2E</span> <ChevronRight size={12} />{" "}
          <span style={{ color: "white" }}>{activeTestFile}</span>
        </div>

        {browserInfo[activeTestFile] && (
          <span data-testid="test-browser" title={`Verified engine: ${browserInfo[activeTestFile].engine} ${browserInfo[activeTestFile].version}`} style={{ color: '#a78bfa', fontSize: '12px' }}>
            Test browser: {({ chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' } as Record<string, string>)[browserInfo[activeTestFile].engine] || browserInfo[activeTestFile].engine}
            {' · '}{browserInfo[activeTestFile].headless ? 'Headless' : 'Headed'}
          </span>
        )}

        {(isRunning || timer > 0 || runStatus !== 'idle') && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginLeft: "12px",
              padding: "4px 10px",
              backgroundColor: isRunning
                ? "rgba(34, 197, 94, 0.05)"
                : "rgba(167, 139, 250, 0.05)",
              borderRadius: "20px",
              border: isRunning
                ? "1px solid rgba(34, 197, 94, 0.2)"
                : "1px solid rgba(167, 139, 250, 0.2)",
            }}
          >
            <span
              style={{
                width: "6px",
                height: "6px",
                backgroundColor: isRunning ? "#22c55e" : "#a78bfa",
                borderRadius: "50%",
                boxShadow: isRunning ? "0 0 8px #22c55e" : "0 0 8px #a78bfa",
              }}
            />
            <span
              style={{
                fontSize: "11px",
                color: isRunning ? "#22c55e" : "#a78bfa",
                fontWeight: "600",
              }}
            >
              {isRunning ? (paused ? 'Paused' : 'Running') : runStatus === "failed" ? "Failed" : runStatus === "interrupted" ? "Interrupted" : runStatus === "incomplete" ? "Incomplete" : runStatus === "skipped" ? "Skipped" : "Complete"}
            </span>
            <span
              style={{
                fontSize: "11px",
                color: "white",
                fontFamily: "monospace",
              }}
            >
              {formatTime(timer)}
            </span>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
        <button
          aria-label="Toggle execution details"
          onClick={onToggleRightPanel}
          style={{
            background: "none",
            border: "1px solid #30363d",
            color: isRightPanelOpen ? "#a78bfa" : "#8b949e",
            padding: "5px 12px",
            borderRadius: "6px",
            cursor: "pointer",
          }}
        >
          {isRightPanelOpen ? (
            <PanelRight size={16} />
          ) : (
            <PanelRightClose size={16} />
          )}
        </button>

        <div
          style={{
            width: "1px",
            height: "20px",
            backgroundColor: "#30363d",
            margin: "0 5px",
          }}
        />

        {isRunning && activeFiles.includes(activeTestFile) && !paused && (
          <button type="button" disabled={queued} onClick={() => sendToRunner('PAUSE_FILE', { fileName: activeTestFile })}>
            {queued ? 'Pausing…' : 'Pause and inspect'}
          </button>
        )}
        {!isRunning ? (
          <button
            title="Run the selected flow"
            onClick={() => handleRun(true)}
            disabled={isRunning || !activeTestFile}
            style={{
              background: "none",
              border: "1px solid #30363d",
              color: "#22c55e",
              padding: "5px 12px",
              borderRadius: "6px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <Play size={14} fill="currentColor" /> Run
          </button>
        ) : (
          <button
            onClick={handleStop}
            style={{
              background: "none",
              border: "1px solid #30363d",
              color: "#f87171",
              padding: "5px 12px",
              borderRadius: "6px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <Square size={14} fill="currentColor" /> Stop
          </button>
        )}
        <button
          title="Rerun the original group of flows"
          onClick={() => handleRun(false)}
            disabled={isRunning}
          style={{
            background: "none",
            border: "1px solid #30363d",
            color: "#8b949e",
            padding: "5px 12px",
            borderRadius: "6px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <RotateCcw size={14} /> Rerun
        </button>
      </div>
    </div>
  );
};
