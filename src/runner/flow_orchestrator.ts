import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { serveRunHistory } from '../reporting/run_history_server';
import { protectHandoffEvidence } from '../native/handoff';
import { isBundledPracticeHandoff } from '../practice/project';
import { serveLocalVideo } from '../reporting/local_video';
import { CLEANUP_BUDGET_MS } from '../native/scenario_cleanup';
import { FIXTURE_CANCEL_GRACE_MS } from './project_fixture';
import { HandoffCoordinator, type HandoffStatus } from './handoff_coordinator';
import { isPauseId, PauseState } from './execution_control';
import { DashboardBrowser } from '../native/dashboard';
import { serveDOMSnapshot } from '../native/evidence';
import { executionPlan } from '../ci/distribution';
import { isLocalDashboardRequest } from '../security/localDashboard';
import { discoverFlows, flowIdentity, projectPath } from '../utils/projectPaths';
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import chalk from "chalk";
import ora from "ora";
import { WebSocketServer } from "ws";
import { FlowWorker } from "./flow_worker";
import { FlowstrideConfig } from "../types";
import { PdfGenerator } from "../reporting/pdf_generator";

// Scenario, file, handoff and worker callbacks can each have work to finish.
const HANDOFF_STOP_GRACE_MS = FIXTURE_CANCEL_GRACE_MS + 4 * CLEANUP_BUDGET_MS + 2500;

export class FlowOrchestrator {
  public static readonly nativeBrowserProtocol = 2;
  public static readonly nativeAssertionProtocol = 1;
  public static readonly nativeValueProtocol = 1;
  public static readonly nativeCIProtocol = 1;
  public static readonly nativeControlProtocol = 1;
  public static readonly nativeInteractionProtocol = 1;
  public static readonly nativeBrowsingProtocol = 1;
  public static readonly nativeDataProtocol = 1;
  public static readonly nativeWorkflowProtocol = 1;
  public static readonly nativeHelperProtocol = 1;
  public static readonly nativeFixtureProtocol = 1;
  public static readonly nativeHandoffProtocol = 1;
  public static readonly nativeScopedBrowserProtocol = 1;
  public static readonly nativePasswordToggleProtocol = 1;
  public static readonly nativeApiProtocol = 1;
  public static readonly nativeApplicationEvidenceProtocol = 1;
  public readonly nativeEventProtocol = 1;
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;

  private globalTestScenarios: any[] = [];
  private stepStatusRegistry: Map<string, string> = new Map();
  private pdfGenerator: PdfGenerator;
  private disconnectTimer: NodeJS.Timeout | null = null;
  private dashboardBrowser = new DashboardBrowser();
  private closing = false;
  private launchId = randomUUID();
  private launchedTab?: WebSocket;
  private originalTarget?: string;
  private originalFiles?: string[];
  private selectedFiles = new Map<string, string>();
  private activeFiles = new Set<string>();
  private queuedPauses = new Set<string>();
  private lastFrames = new Map<string, { fileName: string; base64: string }>();

  private readonly interruptDashboard = async () => {
    if (this.closing) return;
    this.closing = true;
    const exitCode = this.isExecuting ? 130 : process.exitCode ?? 0;
    try {
      const notices = [...(this.wss?.clients || [])].map(client => new Promise<void>(resolve => {
        if (client.readyState !== 1) return resolve();
        client.send(JSON.stringify({ type: 'SERVER_SHUTDOWN', payload: { closeTab: client === this.launchedTab } }), () => resolve());
      }));
      await Promise.race([Promise.all(notices), new Promise(resolve => setTimeout(resolve, 500).unref())]);
      await this.stopDashboardRun();
    } finally {
      await this.close();
      process.exit(exitCode);
    }
  };
  private browserInfoByFile = new Map<string, any>();
  private localVideos = new Set<string>();
  private isExecuting = false;
  private pendingPauses = new Map<string, { payload: PauseState; owner?: never }>();

  constructor(
    private worker: FlowWorker,
    private workerCount: number = 1,
    private config?: FlowstrideConfig,
  ) {
    this.pdfGenerator = new PdfGenerator();
    this.worker.on("worker_event", (data) => {
      this.forwardToDashboard(data.type, data.payload);
    });
  }

  private resumeExecution(pauseId: unknown): boolean {
    if (!isPauseId(pauseId)) return false;
    const pause = this.pendingPauses.get(pauseId);
    if (!pause || !this.isExecuting) return false;
    return this.worker.resumePause(pauseId);
  }

  private forwardToDashboard(type: string, payload: any) {
    if (type === 'BROWSER_FRAME' && this.wss && typeof payload.base64 === 'string') this.lastFrames.set(payload.fileName, payload);
    if (type === 'RUN_START') this.activeFiles.add(payload.fileName);
    if (type === 'FILE_COMPLETE' || type === 'FILE_FAILED') {
      this.lastFrames.delete(payload.fileName);
      this.activeFiles.delete(payload.fileName);
      this.queuedPauses.delete(payload.fileName);
    }
    if (type === 'SUITE_START' || type === 'RUN_COMPLETE') {
      this.lastFrames.clear();
      this.activeFiles.clear();
      this.queuedPauses.clear();
    }
    if (type === 'INSPECT_RESULT') {
      const paused = this.pendingPauses.get(payload.id);
      if (paused) {
        for (const client of this.wss?.clients || []) if (client.readyState === 1) client.send(JSON.stringify({ type, payload }));
      }
      return;
    }
    if (type === 'EXECUTION_PAUSED') {
      this.queuedPauses.delete(payload.fileName);
      console.log('[Flowstride] Paused · ' + String(payload.fileName).replace(/[\x00-\x1f\x7f]/g, '') + ' · Resume in the dashboard.');
      if (!isPauseId(payload?.id) || this.pendingPauses.has(payload.id)) return;
      this.pendingPauses.set(payload.id, { payload: { ...payload } });
    }
    if (type === 'EXECUTION_RESUMED') {
      const pause = this.pendingPauses.get(payload?.id);
      if (!pause) return;
      this.pendingPauses.delete(payload.id);
      if (!payload.cancelled) console.log('[Flowstride] Resumed · ' + String(pause.payload.fileName).replace(/[\x00-\x1f\x7f]/g, ''));
    }
    if (type === 'SUITE_START' || type === 'RUN_COMPLETE') this.pendingPauses.clear();
    if (type === 'BROWSER_INFO') this.browserInfoByFile.set(payload.fileName, payload);
    if (type === 'LOCAL_VIDEO_READY' && typeof payload?.fileName === 'string') this.localVideos.add(payload.fileName);
    if (type === 'SUITE_START') {
      this.browserInfoByFile.clear();
      this.localVideos.clear();
      this.dependencyStates.clear();
    }
    if (type === 'FLOW_DEPENDENCY') {
      if (payload.status === 'ready') this.dependencyStates.delete(payload.fileName);
      else this.dependencyStates.set(payload.fileName, payload);
    }
    this.config?.onRunEvent?.({ type, payload });
    if (this.wss) {
      this.wss.clients.forEach((client) => {
        if (client.readyState === 1)
          client.send(JSON.stringify({ type, payload }));
      });
    }
  }

  private activeExecution?: Promise<boolean>;
  private handoffCoordinator?: HandoffCoordinator;
  private dependencyStates = new Map<string, HandoffStatus>();

  private async stopDashboardRun(): Promise<void> {
    this.abort();
    const execution = this.activeExecution;
    const dependencyRun = !!this.handoffCoordinator;
    if (!dependencyRun || !execution) await this.worker.shutdown();
    if (!execution) return;
    await Promise.race([
      execution.catch(() => false),
      new Promise<void>(resolve => setTimeout(resolve, dependencyRun ? HANDOFF_STOP_GRACE_MS : 5500).unref()),
    ]);
    if (dependencyRun) await this.worker.shutdown();
  }

  private async executeTestRun(targetPath: string) {
    if (this.isExecuting) return false;
    this.isExecuting = true;
    try {
      this.activeExecution = this.executeCurrentRun(targetPath);
      return await this.activeExecution;
    } finally {
      this.activeExecution = undefined;
      this.isExecuting = false;
      this.pendingPauses.clear();
    }
  }

  private async executeCurrentRun(targetPath: string) {
    this.forwardToDashboard("SUITE_START", {});

    if(this.config && !this.config.ci) delete this.config.nativeDataManifest;
    const plan = executionPlan(targetPath, this.config, targetPath === this.originalTarget ? this.originalFiles : undefined);
    this.selectedFiles = new Map(plan.files.map(file => [flowIdentity(file, plan.flowRoot), file]));
    const filesToProcess = plan.files;
    if (this.config) this.config.flowRoot = plan.flowRoot;

    this.globalTestScenarios = [];
    this.stepStatusRegistry.clear();

    if (this.workerCount > 1) {
      console.log(
        chalk.magenta(
          `\n[Notice]: You requested ${this.workerCount} parallel workers, but distributed parallel execution is a Flowstride Enterprise feature.`,
        ),
      );
      console.log(
        chalk.magenta(
          `[Notice]: Visit flowstride.io to upgrade. Falling back to sequential execution...\n`,
        ),
      );
    }

    console.log(
      chalk.gray(`\n[Orchestrator]: Executing in standard sequential mode...`),
    );

    const listener = (data: any) => {
      if (data.type === "STEP_UPDATE") {
        if (data.payload && data.payload.id && data.payload.fileName) {
          const compositeKey = `${data.payload.fileName}_${data.payload.id}`;
          this.stepStatusRegistry.set(compositeKey, data.payload.status);
        }
        this.globalTestScenarios.push(data.payload);
      }
    };

    this.worker.on("worker_event", listener);

    let passed = false;
    try {
      if (plan.handoffs?.length && this.config) {
        const restore = protectHandoffEvidence(this.config, isBundledPracticeHandoff(this.config, plan.handoffs));
        const coordinator = new HandoffCoordinator(plan.handoffs, plan.flowRoot, event => this.forwardToDashboard('FLOW_DEPENDENCY', event));
        this.handoffCoordinator = coordinator;
        try { passed = await this.worker.runBatch(filesToProcess, coordinator.source('main')) && !coordinator.failed; }
        finally { coordinator.clear(); this.handoffCoordinator = undefined; restore(); }
      } else {
        passed = await this.worker.runBatch(filesToProcess);
      }
    } finally { this.worker.off("worker_event", listener); }
    this.forwardToDashboard("RUN_COMPLETE", { status: passed ? 'success' : 'failed' });
    return passed;
  }

  public async start(targetPath: string): Promise<boolean> {
    try {
      if (this.config?.ci) return await this.executeTestRun(targetPath);
      this.originalTarget = targetPath;
      this.originalFiles = discoverFlows(targetPath, this.config?.projectRoot || process.cwd());
      this.worker.dashboardHandlesInterrupt = true;
      process.on('SIGINT', this.interruptDashboard);
      this.httpServer = http.createServer((req, res) => {
        if (!isLocalDashboardRequest(req.headers.host, req.headers.origin)) { res.writeHead(403); res.end('Forbidden'); return; }
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          if (serveDOMSnapshot(req, res, this.config)) return;
          if (serveRunHistory(req, res, this.config?.projectRoot || process.cwd(), this.config?.artifactsDir)) return;

          if (serveLocalVideo(req, res, this.config?.projectRoot || process.cwd(), this.localVideos)) return;
          {
            const uiDistPath = path.join(__dirname, "../../src/ui/dist");

          let reqPath =
            req.url === "/"
              ? "/index.html"
              : req.url?.split("?")[0] || "/index.html";
          let filePath = path.join(uiDistPath, reqPath);

          if (!filePath.startsWith(uiDistPath)) {
            res.writeHead(403);
            return res.end("Forbidden");
          }

          if (fs.existsSync(filePath)) {
            const extname = path.extname(filePath);
            let contentType = "text/html";

            switch (extname) {
              case ".js":
                contentType = "application/javascript";
                break;
              case ".css":
                contentType = "text/css";
                break;
              case ".json":
                contentType = "application/json";
                break;
              case ".png":
                contentType = "image/png";
                break;
              case ".jpg":
                contentType = "image/jpg";
                break;
              case ".svg":
                contentType = "image/svg+xml";
                break;
              case ".ico":
                contentType = "image/x-icon";
                break;
            }

            res.writeHead(200, { "Content-Type": contentType });
            fs.createReadStream(filePath).pipe(res);
          } else {
            const indexPath = path.join(uiDistPath, "index.html");
            if (fs.existsSync(indexPath)) {
              res.writeHead(200, { "Content-Type": "text/html" });
              fs.createReadStream(indexPath).pipe(res);
            } else {
              res.writeHead(404);
              res.end("Flowstride UI not found. Dashboard bundle is missing.");
            }
          }
        }
      });

      this.httpServer.on("error", (e: any) => {
        console.error(
          chalk.red(`\n[Error]: Failed to start local server: ${e.message}`),
        );
        process.exit(1);
      });

      this.wss = new WebSocketServer({ server: this.httpServer, verifyClient: (info: { origin: string; req: http.IncomingMessage }) => Boolean(info.origin) && isLocalDashboardRequest(info.req.headers.host, info.origin) });

      this.wss.on("connection", (ws) => {
        for (const payload of this.browserInfoByFile.values()) ws.send(JSON.stringify({ type: 'BROWSER_INFO', payload }));
        for (const fileName of this.localVideos) ws.send(JSON.stringify({ type: 'LOCAL_VIDEO_READY', payload: { fileName } }));
        ws.send(JSON.stringify({ type: 'DASHBOARD_FILES', payload: { active: [...this.activeFiles.keys()], queued: [...this.queuedPauses] } }));
        for (const { payload } of this.pendingPauses.values()) {
          ws.send(JSON.stringify({ type: 'EXECUTION_PAUSED', payload }));
          const frame = payload.fileName && this.lastFrames.get(payload.fileName);
          if (payload.inspectable && frame) ws.send(JSON.stringify({ type: 'BROWSER_FRAME', payload: frame }));
        }
        for (const payload of this.dependencyStates.values()) ws.send(JSON.stringify({ type: 'FLOW_DEPENDENCY', payload }));
        if (this.disconnectTimer) {
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = null;
        }

        ws.on("message", async (message) => {
          let data: any;
          try { data = JSON.parse(message.toString()); } catch { return; }
          if (!data || typeof data.type !== 'string') return;
          if (this.closing) return;
          if (data.type === 'DASHBOARD_LAUNCHED' && data.payload?.id === this.launchId) {
            if (!this.launchedTab || this.launchedTab.readyState !== 1) this.launchedTab = ws;
            return;
          }
          if (data.type === 'PAUSE_FILE') {
            const name = data.payload?.fileName;
            if (!this.isExecuting || !this.activeFiles.has(name) || this.queuedPauses.has(name) ||
                [...this.pendingPauses.values()].some(pause => pause.payload.fileName === name)) return;
            this.queuedPauses.add(name);
            this.worker.requestDashboardPause(name);
            for (const client of this.wss?.clients || []) if (client.readyState === 1) client.send(JSON.stringify({ type: 'PAUSE_REQUESTED', payload: { fileName: name } }));
            return;
          }
          if (data.type === 'INSPECT_PAUSED') {
            const pause = this.pendingPauses.get(data.payload?.pauseId);
            if (!pause?.payload.inspectable || !this.isExecuting) return;
            this.worker.inspectPausedPage(data.payload);
            return;
          }
          if (data.type === 'RESUME_EXECUTION') { this.resumeExecution(data.payload?.pauseId); return; }

          if (data.type === "EXPORT_PDF_REQ") {
            let scenariosToExport = data.payload || [];
            if (scenariosToExport.length === 0) {
              scenariosToExport = this.globalTestScenarios;
            }
            await this.handleExportPdfRequest(scenariosToExport);
          } else if (data.type === "REPLAY_REQ") {
            await this.worker.handleReplayRequest(data.payload);
          } else if (data.type === "RERUN_REQ") {
            if (this.isExecuting) return;
            const requestedFile = data.payload?.filePath;
            const nextTarget = requestedFile === undefined ? targetPath : this.selectedFiles.get(requestedFile);
            if (!nextTarget) return;
            try {
              await this.executeTestRun(nextTarget);
            } catch (error) {
              console.error('[Flowstride] Could not start dashboard run:', error instanceof Error ? error.message : 'Run setup failed');
              this.forwardToDashboard('RUN_COMPLETE', { status: 'failed' });
            }
          } else if (data.type === "STOP_REQ") {
            console.log(
              chalk.yellow(
                "\nReceived STOP signal from Dashboard. Halting execution...",
              ),
            );
            await this.stopDashboardRun();
            this.forwardToDashboard("RUN_COMPLETE", { status: "aborted" });
          }
        });

        ws.on("close", () => {
          if (!this.closing && this.wss && this.wss.clients.size === 0) {
            this.disconnectTimer = setTimeout(async () => {
              console.log(
                chalk.yellow(
                  "\n[Flowstride]: Dashboard disconnected. Shutting down framework...",
                ),
              );
              try {
                await this.stopDashboardRun();
              } catch (e) {}
              this.wss?.close();
              this.httpServer?.close();
              process.exit(0);
            }, 3000);
          }
        });
      });

      return new Promise<boolean>((resolve, reject) => {
        this.httpServer!.listen(0, '127.0.0.1', async () => {
          try {
            const address = this.httpServer?.address();
            const port =
              typeof address === "object" && address !== null
                ? address.port
                : null;

            if (!port) {
              console.error(
                chalk.red("\n[Error]: Could not bind to an available port."),
              );
              return reject(new Error("No port available"));
            }

            const localUrl = `http://localhost:${port}`;
            console.log(
              chalk.yellow(
                `\n[Dashboard]: Local server running at ${localUrl}`,
              ),
            );

            const isStrictHeadless =
              process.argv.includes("--headless") ||
              !!process.env.CI ||
              !!process.env.GITHUB_ACTIONS ||
              !!process.env.FLOWSTRIDE_API_KEY;

            if (!isStrictHeadless) {
              await this.dashboardBrowser.open(localUrl + '#fs-launch=' + this.launchId, this.config?.browser);
              console.log(`[Dashboard]: ${this.config?.browser === 'firefox' || this.config?.browser === 'webkit' ? this.config.browser : 'system default'} dashboard window; test browser reported after launch${this.config?.headless ? ' (headless tests)' : ''}.`);

              console.log(
                chalk.yellow("[Dashboard]: Waiting for UI connection..."),
              );

              while (this.wss!.clients.size === 0)
                await new Promise((r) => setTimeout(r, 250));

              console.log(chalk.green("[Dashboard]: Connected to UI!"));
            } else {
              console.log(
                chalk.gray(
                  "[Dashboard]: Headless mode active. Bypassing UI auto-launch...",
                ),
              );
            }

            const result = await this.executeTestRun(targetPath);

            resolve(result);
          } catch (err) {
            await this.dashboardBrowser.close();
            reject(err);
          }
        });
      });
    } catch (e: any) {
      throw e;
    }
  }

  public abort() {
    this.pendingPauses.clear();
    this.handoffCoordinator?.cancel('Execution was interrupted before this file could start.');
    this.worker.abort();
  }

  public async close() {
    process.removeListener('SIGINT', this.interruptDashboard);
    this.worker.dashboardHandlesInterrupt = false;
    this.closing = true;
    this.abort();
    await this.dashboardBrowser.close();
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.wss?.clients.forEach(client => client.terminate());
    this.wss?.close(); this.httpServer?.close();
  }

  private async handleExportPdfRequest(testScenariosFromUI: any[]) {
    try {
      const spinner = ora(
        chalk.blue("Compiling high fidelity PDF report..."),
      ).start();

      const pdfPath =
        await this.pdfGenerator.generateTestcasePdf(testScenariosFromUI);

      const pdfBuffer = fs.readFileSync(pdfPath);
      const base64Data = pdfBuffer.toString("base64");

      this.forwardToDashboard("EXPORT_PDF_RES", { base64: base64Data });
      this.forwardToDashboard("EXPORT_PDF_SUCCESS", { path: pdfPath });

      spinner.succeed(chalk.green(`PDF Exported Successfully: ${pdfPath}`));
    } catch (e: any) {
      console.error(
        chalk.red(`\n[Report Error]: Failed to generate PDF - ${e.message}`),
      );
      this.forwardToDashboard("EXPORT_PDF_ERROR", { error: e.message });
    }
  }
}
