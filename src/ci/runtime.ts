import { startPracticeRun } from '../practice/server';
import { archiveNativeRun } from '../reporting/native_history';
import type { HandoffStatus } from '../runner/handoff_coordinator';
import { redactText } from '../security/redaction';
import { evidenceDirectory, writeEvidence, protectEvidenceTree, exportEvidence } from '../security/evidence';
import { assertionText } from '../reporting/assertion_result';
import { prepareWorkflowFeatures } from '../native/workflow_plan';
import { executionPlan } from './distribution';
import { createHash } from 'node:crypto';
import { flowIdentity, videoFileName } from '../utils/projectPaths';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Lexer } from '../parser/lexer';
import { Parser } from '../parser/parser';
import type { FlowstrideConfig } from '../types';
import type { FixtureCleanup } from '../native/scenario_cleanup';

export interface FixtureCleanupResult extends FixtureCleanup {
  status: 'passed' | 'failed';
  error?: string;
}

export interface NativeRunResult {
  protocol: 1; engine: string; status: 'passed' | 'failed' | 'interrupted' | 'skipped';
  duration: number; artifactsDir: string; files: string[]; steps: any[]; errors: string[];
  fixtureCleanups?: FixtureCleanupResult[];
  dependencies?: HandoffStatus[];
  metrics: { total: number; passed: number; failed: number; skipped: number; incomplete: number };
}
function safeName(name: string) { return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0,120) + '-' + createHash('sha256').update(name).digest('hex').slice(0,12); }
function xml(value: unknown) { return String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/[<>&"']/g, char => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]!)); }
export async function runNativeCI(worker: any, orchestrator: any, target: string, config: FlowstrideConfig, engine: string, practice = false): Promise<NativeRunResult> {
  const started = Date.now();
  let stopPractice: (() => Promise<void>) | undefined;
  delete config.nativeDataManifest;
  const artifactRoot = config.artifactsDir!;
  evidenceDirectory(config, artifactRoot);
  const directory = fs.mkdtempSync(path.join(artifactRoot, 'run-'));
  evidenceDirectory(config, directory);
  config.artifactsDir = directory;
  let plan: ReturnType<typeof executionPlan> | undefined;
  const browsers = new Map<string, any>();
  const attempts: any[] = []; const attemptSteps = new Map<string, any[]>(); const timings: Record<string,number> = {};
  const steps = new Map<string, any>(); const completed = new Set<string>(); const errors: string[] = [];
  const fixtureCleanups: FixtureCleanupResult[] = [];
  const dependencies: HandoffStatus[] = [];
  const iteratedSteps = new Set<string>();
  const isIteration = (file: string, id: string) => {
    const base = id.replace(/(?:_row\d+)+$/, '');
    return base !== id && iteratedSteps.has(file + ':' + base);
  };
  const planned = new Map<string, any>(); let bailed = false;
  let hasRunnableScenario = false;
  let expected = 0; let files: string[] = []; let server: ChildProcess | undefined; let interrupted = false;
  const interrupt = () => { interrupted = true; worker.abort(); orchestrator.abort?.(); };
  const event = (data: any) => {
    if (!data?.payload) return;
    const p = data.payload;
    if (data.type === 'BROWSER_INFO') browsers.set(p.fileName, { ...p });
    if (data.type === 'BAIL') bailed = true;
    if (data.type === 'SCENARIO_ATTEMPT') {
      attemptSteps.set(p.fileName, []);
      if (p.attempt > 1) for (const [key, step] of steps) {
        if (step.fileName === p.fileName && step.scenario === p.scenario &&
            step.dataCase?.index === p.dataCase?.index && isIteration(p.fileName, step.id)) steps.delete(key);
      }
    }
    if (data.type === 'SCENARIO_RESULT') attempts.push({ ...p, steps: [...(attemptSteps.get(p.fileName) || [])] });
    if (data.type === 'FILE_COMPLETE' || data.type === 'FILE_FAILED') timings[p.fileName] = p.duration;
    if (data.type === 'STEP_UPDATE') attemptSteps.get(p.fileName)?.push({ ...p, screenshot: undefined });
    if (data.type === 'LOG_EVENT' && p.status === 'error') {
      const active = [...steps.values()].reverse().find(step => step.fileName === p.fileName && step.status === 'running');
      if (active) active.error = p.details?.rawError || p.summary;
    }
    if (data.type === 'STEP_UPDATE' || data.type === 'STEP_ADD') {
      const key = `${p.fileName}:${p.id}`;
      steps.set(key, { ...steps.get(key), ...p, screenshot: undefined });
      if (p.status === 'failed' && typeof p.screenshot === 'string') {
        const match = p.screenshot.match(/^data:image\/(png|jpeg);base64,(.+)$/s) || (/^[A-Za-z0-9+/=\r\n]+$/.test(p.screenshot) ? ['', 'jpeg', p.screenshot] : null);
        if (match) writeEvidence(config, path.join(directory, `${safeName(p.fileName)}-${safeName(p.id)}.${match[1] === 'jpeg' ? 'jpg' : 'png'}`), Buffer.from(match[2], 'base64'));
      }
    }
    if (data.type === 'FILE_COMPLETE' || data.type === 'FILE_FAILED') completed.add(p.fileName);
    if (data.type === 'FILE_FAILED' && ![...steps.values()].some(step => step.fileName === p.fileName && step.status === 'failed')) errors.push(`${p.fileName}: ${p.error || 'Execution failed'}`);
    if (data.type === 'BROWSER_ERROR' && config.browserErrors !== 'record') errors.push(`Browser: ${p.message}`);
    if (data.type === 'CLOUD_SYNC') config.cloudSyncResult = p;
    if (data.type === 'FLOW_DEPENDENCY') {
      dependencies.push(p);
      if (p.status === 'blocked') {
        completed.add(p.fileName);
        errors.push(p.fileName + ': ' + p.reason);
        for (const [key, step] of planned) if (step.fileName === p.fileName) {
          steps.set(key, { ...step, reason: undefined, status: 'blocked', skipReason: p.reason, userMessage: p.reason });
        }
      }
    }
    if (data.type === 'WORKER_ERROR') errors.push(p.message || 'Worker failed');
    if (data.type === 'FIXTURE_CLEANUP') {
      fixtureCleanups.push(p);
      if (p.status === 'failed') errors.push(`${p.fileName}:${p.sourceLine}: ${p.error}`);
    }
  };
  // Modern orchestrators forward child-process events here; the worker listener
  // also supports older compatible Pro packages. Step maps make duplicates harmless.
  config.onRunEvent = event;
  if (orchestrator.nativeEventProtocol !== 1) worker.on('worker_event', event);
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    plan = executionPlan(target, config);
    files = plan.files;
    config.flowRoot = plan.flowRoot;
    if (!plan.allFiles.length) throw new Error('No .flow tests found.');
    const handoffFeatures = new Map(plan.handoffs?.map(job => [job.file, job.features]));
    for (const file of files) {
      const features = handoffFeatures.get(file) ?? prepareWorkflowFeatures(new Parser(new Lexer(fs.readFileSync(file, 'utf8')).tokenise()).parse(), config);
      for (const feature of features) for (const scenario of feature.scenarios) {
        const blocks: string[] = [];
        for (const step of scenario.steps) {
          if (blocks.includes('each')) iteratedSteps.add(flowIdentity(file, config.flowRoot) + ':' + step.id);
          if (step.action !== 'scoped') continue;
          if (step.payload.op === 'each' || step.payload.op === 'within') blocks.push(step.payload.op);
          if (step.payload.op === 'end') blocks.pop();
        }
      }
      hasRunnableScenario ||= features.some(feature => feature.scenarios.some(scenario => !scenario.skipReason && scenario.steps.length));
      for (const feature of features) for (const scenario of feature.scenarios) for (const step of scenario.steps) {
        const fileName = flowIdentity(file, config.flowRoot);
        planned.set(`${fileName}:${step.id}`, { id: step.id, description: step.blockDescription, command: step.action, fileName, status: 'skipped', reason: 'bail' });
      }
      expected += features.reduce((n: number, feature: any) => n + feature.scenarios.reduce((m: number, scenario: any) => m + scenario.steps.length, 0), 0);
    }
    if (files.length && !expected) throw new Error('No executable test steps found.');
    if (practice && hasRunnableScenario) {
      stopPractice = await startPracticeRun(config);
    } else if (!practice && config.webServer && hasRunnableScenario) {
      const settings = config.webServer;
      const probe = async () => { try { return (await fetch(settings.url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } };
      if (await probe()) throw new Error('webServer readiness URL is already serving; refusing to test an unowned server.');
      const output = fs.openSync(path.join(directory, 'web-server.log'), 'a', 0o600);
      try { server = spawn(settings.command, { cwd: settings.cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', output, output] }); }
      finally { fs.closeSync(output); }
      let spawnError: Error | undefined;
      server.on('error', error => { spawnError = error; });
      const deadline = Date.now() + (settings.timeout ?? 30000);
      while (!(await probe())) {
        if (interrupted) throw new Error('Run interrupted during server startup.');
        if (spawnError) throw spawnError;
        if (server.exitCode !== null || server.signalCode !== null) throw new Error('webServer exited before readiness.');
        if (Date.now() > deadline) throw new Error('webServer readiness timed out.');
        await delay(100);
      }
    }
    if (interrupted) throw new Error('Run interrupted before execution.');
    const ok = await orchestrator.start(target);
    if (ok === false && ![...steps.values()].some(step => step.status === 'failed')) errors.push('Engine reported a failed run.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const secrets = [config.machineToken || '', ...Object.entries(process.env)
      .filter(([key]) => /password|token|secret|api.?key/i.test(key))
      .map(([, value]) => value || '')];
    const safe = redactText(message, secrets);
    errors.push(safe);
    if (!plan) console.error(`[Flowstride plan] ${safe}`);
  }
  finally {
    try { await worker.shutdown(); } catch (error) { errors.push(`Cleanup failed: ${String(error)}`); }
    try { await orchestrator.close?.(); } catch (error) { errors.push(`Orchestrator cleanup failed: ${String(error)}`); }
    if (server?.pid) {
      const stop = (signal: NodeJS.Signals) => { try { process.kill(process.platform === 'win32' ? server!.pid! : -server!.pid!, signal); } catch (error: any) { if (error.code !== 'ESRCH') errors.push(`Server cleanup: ${error.message}`); } };
      stop('SIGTERM');
      await Promise.race([new Promise<void>(resolve => server!.once('exit', () => resolve())), delay(1000)]);
      // Terminate remaining descendants even if the shell exited first.
      stop('SIGKILL');
    }
    try { await stopPractice?.(); }
    catch { errors.push('Could not shut down the local practice app.'); }
    worker.off('worker_event', event); delete config.onRunEvent;
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  }
  if (interrupted) errors.push('Run interrupted.');
  if (bailed) for (const [key, step] of planned) if (!steps.has(key)) steps.set(key, step);
  const results = [...steps.values()];
  const terminal = results.filter(step => ['passed','failed','skipped','not_tested','blocked'].includes(step.status));
  expected += results.filter(step => isIteration(step.fileName, step.id)).length;
  const incomplete = Math.max(0, expected - terminal.length);
  for (const file of files) if (!bailed && !completed.has(flowIdentity(file, config.flowRoot))) errors.push(`Incomplete file: ${flowIdentity(file, config.flowRoot)}`);
  if (results.some(step => !['passed','failed','skipped','not_tested','blocked'].includes(step.status))) errors.push('Unfinished test steps.');
  if (terminal.length > expected) errors.push('Engine produced an unexpected step count.');
  const metrics = { total: expected, passed: results.filter(s => s.status === 'passed').length,
    failed: results.filter(s => s.status === 'failed').length, skipped: results.filter(s => ['skipped','not_tested','blocked'].includes(s.status)).length, incomplete };
  if (config.failOnFlaky && attempts.some(attempt => attempt.flaky)) errors.push('Flaky scenarios are configured to fail CI.');
  const result: NativeRunResult & { cloudSync?: unknown; attempts?: any[]; timings?: Record<string,number>; distribution?: unknown } = { cloudSync: config.cloudSyncResult, browser: config.browser || 'chromium', browsers: [...browsers.values()], protocol: 1, engine, status: interrupted ? 'interrupted' : errors.length || metrics.failed || incomplete ? 'failed' : results.length && results.every(step => step.skipReason) ? 'skipped' : 'passed',
    duration: Date.now() - started, artifactsDir: directory, files: files.map(file => flowIdentity(file, config.flowRoot)), steps: results, errors, ...(fixtureCleanups.length && { fixtureCleanups }), ...(dependencies.length && { dependencies }), metrics, attempts, timings, distribution: { ...plan, handoffs: undefined, files: undefined, flowRoot: undefined } } as any;
  // Existing workers finalize videos into these locations. Copy only run files,
  // never the project directory or credentials.
  if (!plan?.handoffs && config.recordVideo !== false) for (const file of files) {
    for (const folder of ['artifacts','mock-cloud']) {
      const video = path.join(process.cwd(), '.flowstride', folder, videoFileName(flowIdentity(file, config.flowRoot)));
      if (fs.existsSync(video) && fs.statSync(video).mtimeMs >= started) {
        fs.copyFileSync(video, path.join(directory, path.basename(video)));
        break;
      }
    }
  }
  protectEvidenceTree(config, directory);
  config.artifactsDir = artifactRoot;
  fs.writeFileSync(path.join(artifactRoot, 'timings.json'), JSON.stringify(timings, null, 2));
  const portableReport = exportEvidence(result);
  fs.writeFileSync(path.join(artifactRoot, 'summary.json'), JSON.stringify(portableReport, null, 2));
  const cases = results.map(step => `<testcase classname="${xml(step.fileName)}" name="${xml(step.description || step.id)}">${step.status === 'failed' ? `<failure message="${xml(step.error || 'Test step failed')}"/>` : ['skipped','not_tested','blocked'].includes(step.status) ? step.skipReason ? `<skipped message="${xml(step.skipReason)}"/>` : '<skipped/>' : ''}${step.assertion || step.userMessage ? `<system-out>${xml(step.assertion ? assertionText(step.assertion) : step.userMessage)}</system-out>` : ''}</testcase>`);
  for (const error of errors) cases.push(`<testcase name="execution"><error message="${xml(error)}"/></testcase>`);
  if (incomplete) cases.push(`<testcase name="completion"><failure message="${incomplete} incomplete steps"/></testcase>`);
  fs.writeFileSync(path.join(artifactRoot, 'junit.xml'), `<?xml version="1.0"?><testsuite name="Flowstride" tests="${cases.length}" failures="${metrics.failed + (incomplete ? 1 : 0)}" errors="${errors.length}" skipped="${metrics.skipped}">${cases.join('')}</testsuite>`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Flowstride · ${config.device}\nResult: **${result.status}** (${engine})\n\nPassed: ${metrics.passed}; failed: ${metrics.failed}; skipped: ${metrics.skipped}; incomplete: ${metrics.incomplete}.\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const failures = results.filter(step => step.status === 'failed').map(step => `<details><summary>${xml(step.commandLabel || step.command || 'Step')} · ${xml(step.fileName)}</summary><pre>${xml(step.error || (step.assertion ? assertionText(step.assertion) : 'Failed without an adapter diagnostic.'))}</pre></details>`);
    for (const error of errors) failures.push(`<pre>${xml(error)}</pre>`);
    if (failures.length) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'\n'+failures.join('\n')+'\n');
  }
  protectEvidenceTree(config, artifactRoot);
  try { archiveNativeRun(config.projectRoot || process.cwd(), portableReport, started); }
  catch { console.warn('[Flowstride] Could not save this run to local history.'); }
  return result;
}
