import { interactWithPausedPage } from './paused_page';
import { ScopedBrowser } from '../native/scoped_browser';
import { createHash } from 'node:crypto';
import { handoffSecrets, snapshotHandoff, type HandoffCommand, type HandoffValue } from '../native/handoff';
import type { HandoffAssignment, HandoffWorkerSource } from './handoff_coordinator';
import { isWorkflowToken, prepareWorkflowFeatures } from '../native/workflow_plan';
import { cleanupRegistration, resolveCleanupTarget, ScenarioCleanup, type FixtureCleanup } from '../native/scenario_cleanup';
import { caseRows, type CaseScenario, type CaseInfo } from '../native/data_plan';
import { loadDataSchema, casesSchema, loadProjectData, dataSecrets } from '../native/project_data';
import { interpolateData, hasExactDataReference } from '../native/data_references';
import { isSensitiveField } from '../security/sensitiveFields';
import { ExecutionControl, isPauseId } from './execution_control';
import { callProjectHelper, invokeProjectHelper, resolveProjectHelper } from './project_helper';
import { setupFixture, type FixtureRelease } from './project_fixture';
import { practiceHandoffFrames } from '../practice/project';
import { localVideoPath } from '../reporting/local_video';
import { isCIEnvironment } from '../ci/config';
import { poll } from '../native/validation';
import { dataSnapshot, readBrowserProperty } from '../native/paths';
import { replaySecretValues } from "../security/manualReplay";
import { redactPayload } from "../security/redaction";
import { evidenceDirectory, prepareEvidenceFile, protectEvidenceTree, screenshotEvidence } from '../security/evidence';
import { readPrivateState, writePrivateState, stateSessionFile } from "../security/privateState";
import { commandSecrets, runtimeFailure } from '../reporting/runtime_failure';
import { assertionText, commandLabel, failedAssertion, unexecutedAssertion, type AssertionResult } from '../reporting/assertion_result';
import { validateExpectationType, validateApiAssertions, validateResponseTimeThreshold, validateControlDuration, validateControlMessage, isSoftAssertionStep } from '../parser/assertion_contract';
import { nativeStepTimeout } from '../native/deadline';
import { NativeRuntime } from '../native/runtime';
import { withDeadline } from '../ci/deadline';
import { buildReplayRequest, ReplayRequestError } from '../utils/replayRequest';
import { flowIdentity, videoFileName, projectPath } from '../utils/projectPaths';
import { redactWorkerPayload, redactText } from '../security/redaction';
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import ora from "ora";
import { EventEmitter } from "events";
import { WebAdapter } from "../adapters/web/playwright";
import { ApiAdapter } from "../adapters/api/undici";
import { SessionManager } from "../sessions/manager";
import { FlowstrideConfig } from "../types";
import { Lexer } from "../parser/lexer";
import { Parser, ScenarioNode, DeclarationNode, type HelperCallPayload, type FixtureCallPayload, type StepNode } from "../parser/parser";
import { DataGenerators } from "./data_generators";
import { PluginManager } from "./plugin_manager";
import { DOMStripper } from "./dom_stripper";

type LogType =
  | "ACTION"
  | "REST"
  | "GRAPHQL"
  | "ASSERT"
  | "CONSOLE"
  | "ERROR"
  | "FILE_HEADER";

export interface SmartSelectorToken {
  rawTarget: string;
  relation?: "near" | "above" | "under" | "below" | "leftOf" | "rightOf";
  anchor?: string;
  inside?: string;
  index?: number;
  isRawCSS?: boolean;
}

export class FlowWorker extends EventEmitter {
  public static readonly nativeBrowserProtocol = 2;
  public static readonly nativeAssertionProtocol = 1;
  public static readonly nativeValueProtocol = 1;
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
  private control = new ExecutionControl(
    pause => this.broadcast('EXECUTION_PAUSED', pause),
    pause => this.broadcast('EXECUTION_RESUMED', pause),
  );
  private paceMilliseconds = 0;
  private currentScenarioName = '';
  private currentStepId = '';
  private currentStepLine?: number;
  private isSilent = process.env.FLOWSTRIDE_PARALLEL === "true";
  private isAborted = false;
  private bailTriggered = false;
  private isDebugHalted = false;
  private native: NativeRuntime;
  private currentAssertion?: AssertionResult;
  private commandSecretValues: string[] = [];
  private batchPassed = true;
  private attempt = 1;
  private maxAttempts = 1;
  private fallbackStream?: NodeJS.Timeout;
  private interceptedContexts = new WeakSet<object>();

  private currentStepContext: string = "Initializing...";
  private currentFileName: string = "System";
  private currentFlowPath = "";
  private practiceFrames?: ReturnType<typeof practiceHandoffFrames>;
  private activeAudioPath: string | undefined = undefined;

  private currentCdpSession: any = null;
  private dataGen: DataGenerators | null = null;

  private localVariables: Record<string, any> = {};
  private extractedSecretValues = new Set<string>();
  private static extractedGlobalSecretValues = new Set<string>();
  private localBrowserSessions: Record<string, any> = {};

  private static globalVariables: Record<string, any> = {};
  private static globalBrowserSessions: Record<string, any> = {};

  private lastApiUrl: string = "";

  private dataAliases = new Set<string>();
  private currentDataCase?: CaseInfo;
  private caseGroup?: { group:string; state:any; rows:Record<string,unknown>[] };

  private async executeDataStep(method:string,input:unknown):Promise<void> {
    if(method==='data.seed'){
      if(!this.dataGen)this.dataGen=new DataGenerators();
      const context=JSON.stringify([this.currentFileName,this.currentDataCase?.scenario||this.currentScenarioName,this.currentDataCase?.index??null]);
      this.dataGen.setSeed(input as string,context);return;
    }
    if(method==='data.cases'){
      const declaration=casesSchema.parse(dataSnapshot(input));
      if(!this.currentDataCase || declaration.as!==this.currentDataCase.binding || path.resolve(this.config.projectRoot||process.cwd(),declaration.file)!==path.resolve(this.config.projectRoot||process.cwd(),this.currentDataCase.file))throw new Error('flow.data.cases must be planned as the first command in Given; it cannot be invoked as an ordinary runtime loop.');
      return;
    }
    if(!['data.load','file.read'].includes(method))throw new Error(`Unknown project-data command: flow.${method}`);
    const data=loadDataSchema.parse(dataSnapshot(input)),loaded=loadProjectData(this.config,data.file,data.format);
    Object.defineProperty(this.localVariables,data.as,{value:loaded.value,writable:true,enumerable:true,configurable:true});
    this.dataAliases.add(data.as);
    for(const secret of dataSecrets(loaded.value,isSensitiveField(data.as)))this.extractedSecretValues.add(secret);
  }
  private async checkpointCaseState() {
    return { profiles:await this.web.checkpointProfiles(), variables:structuredClone(this.localVariables), sessions:structuredClone(this.localBrowserSessions), globals:structuredClone(FlowWorker.globalVariables), globalSessions:structuredClone(FlowWorker.globalBrowserSessions), store:structuredClone(this.store.getAll?.()), api:this.api.checkpointState?.(), aliases:[...this.dataAliases], generator:this.dataGen?.checkpoint() };
  }
  private async restoreCaseState(state:any) {
    await this.native.dispose();
    this.localVariables=structuredClone(state.variables);this.localBrowserSessions=structuredClone(state.sessions);
    FlowWorker.globalVariables=structuredClone(state.globals);FlowWorker.globalBrowserSessions=structuredClone(state.globalSessions);
    if(state.store){this.store.clear();for(const[key,value]of Object.entries(structuredClone(state.store)))this.store.set(key,value);}
    if(state.api)this.api.restoreState(state.api);else this.api.resetState();
    this.dataAliases=new Set(state.aliases);if(state.generator){this.dataGen=new DataGenerators(state.generator.runId,state.generator.workerId);this.dataGen.restore(state.generator);}
    await this.web.restoreProfiles(state.profiles);
  }
  private async runPreparedScenario(scenario:CaseScenario,declarations:DeclarationNode[]):Promise<boolean> {
    const info=scenario.dataCase;
    if(this.caseGroup && this.caseGroup.group!==info?.group){await this.restoreCaseState(this.caseGroup.state);this.caseGroup=undefined;this.currentDataCase=undefined;}
    if(info){
      if(!this.caseGroup){
        const loaded=caseRows(this.config,info.file,info.format);
        if(loaded.sha256!==info.sha256)throw new Error(`Dataset ${JSON.stringify(info.file)} changed after planning. Start a new run.`);
        for(const secret of dataSecrets(loaded.rows))this.extractedSecretValues.add(secret);
        this.caseGroup={group:info.group,state:await this.checkpointCaseState(),rows:loaded.rows};
      }else await this.restoreCaseState(this.caseGroup.state);
      this.currentDataCase=info;
      const row=dataSnapshot(this.caseGroup.rows[info.index]);
      Object.defineProperty(this.localVariables,info.binding,{value:row,writable:true,enumerable:true,configurable:true});this.dataAliases.add(info.binding);
      if(this.dataGen?.isSeeded())this.dataGen=this.dataGen.fork(JSON.stringify([this.currentFileName,info.scenario,info.index]));
    }else this.currentDataCase=undefined;
    return this.runScenarioWithRetries(scenario,declarations);
  }

  private activeCleanup?: ScenarioCleanup;
  private cleanupReport?: Promise<boolean>;
  private fixtureCancellation = new AbortController();
  private pendingFixtureSetup?: Promise<void>;
  private handoffSource?: HandoffWorkerSource;
  private handoffFile?: HandoffAssignment;
  private handoffFileCleanup?: ScenarioCleanup;
  private handoffRunCleanup?: ScenarioCleanup;
  private handoffRunReport?: Promise<boolean>;
  private handoffOutputs = new Map<string, HandoffValue>();
  private attemptHandoffs = new Map<string, HandoffValue>();
  private publishesInAttempt?: Set<string>;
  private workerFixtureValues = new Map<string, unknown>();
  private workerFixtureCleanup?: ScenarioCleanup;
  private workerCleanupReport?: Promise<boolean>;
  private fixtureBindings = new Map<string, { previous?: PropertyDescriptor; wasAlias: boolean }>();

  private reportSkippedScenario(scenario: ScenarioNode): void {
    const reason = scenario.skipReason!;
    this.currentScenarioName = scenario.name;
    this.currentDataCase = undefined;
    const fileName = this.currentFileName;
    this.broadcast('RUN_START', { fileName, scenarioName: scenario.name });
    this.broadcast('SCENARIO_ATTEMPT', { fileName, scenario: scenario.name, attempt: 1 });
    for (const step of scenario.steps) {
      const [type] = step.blockDescription.split(' ');
      const payload = {
        id: step.id,
        fileName,
        scenario: scenario.name,
        commandLabel: commandLabel(step.action, step.payload),
        sourceLine: step.line,
        status: 'skipped',
        skipReason: reason,
        userMessage: reason,
      };
      this.broadcast('STEP_ADD', { ...payload, type, command: step.action, description: step.blockDescription.slice(type.length).trim() });
      this.broadcast('STEP_UPDATE', payload);
    }
    this.broadcast('SCENARIO_RESULT', { fileName, scenario: scenario.name, attempt: 1, status: 'skipped', skipReason: reason, duration: 0 });
    if (!this.isSilent) console.log(redactText(`    [Skipped] ${scenario.name}: ${reason}`, this.secretValues()));
  }

  private finishScenarioCleanup(): Promise<boolean> {
    if (this.cleanupReport) return this.cleanupReport;
    if (!this.activeCleanup?.hasEntries) return Promise.resolve(false);
    return this.cleanupReport ??= this.reportCleanup(this.activeCleanup);
  }

  private finishWorkerFixtures(): Promise<boolean> {
    if (!this.workerFixtureCleanup) return Promise.resolve(false);
    return this.workerCleanupReport ??= this.reportCleanup(this.workerFixtureCleanup).finally(() => this.workerFixtureValues.clear());
  }

  private finishHandoffCleanup(): Promise<boolean> {
    if (!this.handoffRunCleanup?.hasEntries) return Promise.resolve(false);
    return this.handoffRunReport ??= this.reportCleanup(this.handoffRunCleanup);
  }

  private async reportCleanup(cleanup: ScenarioCleanup): Promise<boolean> {
    let failed = false;
    for (const outcome of await cleanup.drain()) {
      const { error } = outcome;
      failed ||= !!error;
      if ('fixture' in outcome) {
        const fixture = outcome.fixture;
        const message = error
          ? `Fixture "${fixture.name}" cleanup failed: ${error}`
          : `Fixture "${fixture.name}" cleanup completed.`;
        const diagnostic = redactText(message, this.secretValues()).slice(0, 12000);
        this.broadcast('FIXTURE_CLEANUP', { ...fixture, status: error ? 'failed' : 'passed', error: error ? diagnostic : undefined });
        this.emitLog(error ? 'ERROR' : 'ACTION', error ? 'error' : 'info',
          diagnostic, { commandLabel: 'fixture cleanup', sourceLine: fixture.sourceLine }, undefined, fixture.fileName);
        if (!this.isSilent) console.log('    [Cleanup] ' + diagnostic.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''));
        continue;
      }
      const { step, status } = outcome;
      const file = step.sourceFile || this.currentFileName;
      const diagnostic = error ? `${file}:${step.line}: ${error}` : undefined;
      const message = error || `Cleanup DELETE completed (HTTP ${status}).`;
      this.broadcast('STEP_UPDATE', {
        id: step.id,
        fileName: this.currentFileName,
        sourceFile: file,
        sourceLine: step.line,
        status: error ? 'failed' : 'passed',
        cleanupStatus: status,
        error: diagnostic || null,
        userMessage: message,
      });
      this.emitLog(error ? 'ERROR' : 'ACTION', error ? 'error' : 'info',
        diagnostic || message, { stepId: step.id, commandLabel: 'flow.cleanup.register' });
      if (!this.isSilent) console.log(redactText(`    [Cleanup] ${diagnostic || message}`, this.secretValues()));
    }
    return failed;
  }

  constructor(
    private config: FlowstrideConfig,
    private web: WebAdapter,
    private api: ApiAdapter,
    private store: any,
    private sessions: SessionManager,
    private pluginManager?: PluginManager,
  ) {
    super();
    this.native = new NativeRuntime(web, config, {delay:ms => this.control.delay(ms),cancelled:() => this.isAborted});
    this.web.onPageChanged = async () => { await this.startStreaming(); await this.setupNetworkInterception(); };
  }

  private broadcast(type: string, payload: any) {
    if(this.currentDataCase){
      const info={index:this.currentDataCase.index+1,total:this.currentDataCase.total,file:this.currentDataCase.file};
      if(['RUN_START','SCENARIO_ATTEMPT','SCENARIO_RESULT'].includes(type))payload={...payload,dataCase:info};
      if(type==='STEP_ADD'&&typeof payload.description==='string'&&!payload.description.endsWith(`· Case ${info.index}/${info.total}`))payload={...payload,description:payload.description+` · Case ${info.index}/${info.total}`};
    }
    if (["STEP_ADD","STEP_UPDATE","LOG_EVENT"].includes(type)) payload = { ...payload, ...(this.currentScenarioName ? {scenario:this.currentScenarioName} : {}), ...(this.currentDataCase ? {dataCase:{index:this.currentDataCase.index+1,total:this.currentDataCase.total,file:this.currentDataCase.file}} : {}), attempt: this.attempt, profile: this.web.activeProfile || "default" };
    const safe = redactWorkerPayload(type, payload, this.secretValues(), this.config.ci === false && !this.config.protectedHandoff);
    if (['EXECUTION_PAUSED','EXECUTION_RESUMED','INSPECT_RESULT'].includes(type) && isPauseId(payload?.id)) {
      // A generated routing identifier is opaque, not application data or a credential.
      safe.id = payload.id;
      // Redaction can expand strings, so bound presentation fields after sanitization.
      if (typeof safe.message === 'string') safe.message = safe.message.slice(0,32768);
      for (const field of ['fileName','scenario','stepId','profile']) if (typeof safe[field] === 'string') safe[field] = safe[field].slice(0,4096);
    }
    this.emit('worker_event', { type, payload: safe });
  }

  private secretValues(): string[] {
    return [...FlowWorker.extractedGlobalSecretValues, ...this.extractedSecretValues, ...this.commandSecretValues, this.config.machineToken || '', ...(this.dataGen?.sensitiveValues?.() || []), ...Object.entries(process.env).filter(([key]) => /password|token|secret|api.?key/i.test(key)).map(([,value]) => String(value)), ...Object.entries(this.localVariables).filter(([key]) => /password|passcode|token|secret|otp|api.?key/i.test(key)).map(([,value]) => String(value))];
  }

  private assertionForStep(step: any): AssertionResult | undefined {
    if (!this.currentAssertion) return;
    const value = { ...this.currentAssertion, sourceFile:step.sourceFile || this.currentFileName, sourceLine:step.line, profile:this.web.activeProfile || 'default' };
    return redactWorkerPayload('STEP_UPDATE', { assertion:value }, this.secretValues()).assertion;
  }

  private printAssertion(value: AssertionResult | undefined) {
    if (!this.isSilent && value) console.log(assertionText(value).split('\n').map(line=>'        '+line).join('\n'));
  }

  private emitLog(
    type: LogType,
    status: "success" | "error" | "info" | "warning",
    summary: string,
    details: any,
    customId?: string,
    overrideFileName?: string,
  ) {
    const id = customId || Math.random().toString(36).substr(2, 9);
    this.broadcast("LOG_EVENT", {
      id,
      timestamp: new Date().toLocaleTimeString(),
      type,
      status,
      summary,
      stepContext: this.currentStepContext,
      details,
      fileName: overrideFileName || this.currentFileName,
    });
    return id;
  }

  private translateError(error: any, action: string, payload: any): string {
    return runtimeFailure(action,payload,error,{file:this.currentFileName,profile:this.web.activeProfile || 'default',timeout:this.config.timeout});
  }

  private async captureStepContext(
    payload: any,
  ): Promise<{ screenshot?: string; boundingBox?: any }> {
    let page: any;
    try { page = this.web.getPage(); } catch { return {}; }
    const context: { screenshot?: string; boundingBox?: any } = {};

    try {
      const preview = this.practiceFrames;
      if (preview) {
        const url = page.url();
        if (!url.startsWith(preview.origin + '/')) return {};
        const buffer = await page.screenshot({
          type: 'jpeg', quality: 50, timeout: 3000,
          // The local examples use synthetic names and emails. Show passwords as dots.
          mask: [page.locator('input:not(#login-email, #user-name, #user-email, [type="password"]), textarea, [contenteditable]')],
          maskColor: '#e4e0eb',
          style: 'input[type="password"] { -webkit-text-security: disc !important; }',
        });
        if (page.url() !== url) return {};
        context.screenshot = buffer.toString('base64');
        this.broadcast('BROWSER_FRAME', { base64: context.screenshot, fileName: this.currentFileName });
        this.broadcast('URL_CHANGE', { url, title: await page.title(), fileName: this.currentFileName });
      } else {
        if (!screenshotEvidence(this.config)) return {};
        const buffer = await page.screenshot({ type: 'jpeg', quality: 50 });
        context.screenshot = buffer.toString('base64');
      }
    } catch (e) {}

    if (payload && payload.selector) {
      try {
        const box = await page
          .locator(payload.selector)
          .boundingBox({ timeout: 500 });
        if (box) {
          context.boundingBox = box;
        }
      } catch (e) {}
    }

    return context;
  }

  private resolveTextVariables(text: string | any): string | any {
    if (typeof text !== "string") {
      return text;
    }

    let resolved = text;

    resolved = resolved.replace(
      /\{\{env\.([a-zA-Z0-9_]+)\}\}/g,
      (_, varName) => {
        const val = process.env[varName];
        if (val === undefined) {
          throw new Error(
            `Environment Error: The variable "{{env.${varName}}}" is undefined. Make sure it is set in your OS or .env file.`,
          );
        }
        return val;
      },
    );

    resolved = resolved.replace(/@global\[(.*?)\]/g, (_, varName) => {
      const val = FlowWorker.globalVariables[varName];
      if (val === undefined)
        throw new Error(
          `State Error: Global variable "@global[${varName}]" is undefined.`,
        );
      return val;
    });

    resolved = resolved.replace(/@([a-zA-Z0-9_]+)/g, (match, varName) => {
      const val = this.localVariables[varName];
      return val !== undefined ? val : match;
    });
    return resolved;
  }

  private resolveTemplateData(obj: any): any {
    if (typeof obj === "string") {
      return interpolateData(obj,this.dataAliases,this.localVariables,text=>{
        let resolved=this.resolveTextVariables(text);if(this.dataGen)resolved=this.dataGen.resolve(resolved);return resolved;
      });
    }
    if (Array.isArray(obj))
      return obj.map((item) => this.resolveTemplateData(item));
    if (obj !== null && typeof obj === "object") {
      const resolvedObj: any = {};
      for (const [key, value] of Object.entries(obj)) {
        resolvedObj[key] = this.resolveTemplateData(value);
      }
      return resolvedObj;
    }
    return obj;
  }

  private resolveTypedAssertionValue(value: any, strictMissing = true): any {
    if (typeof value === 'string') {
      if(hasExactDataReference(value,this.dataAliases))return interpolateData(value,this.dataAliases,this.localVariables,text=>this.resolveTemplateData(text),true);
      const global = /^@global\[([A-Za-z_]\w*)\]$/.exec(value);
      const local = /^@([A-Za-z_]\w*)$/.exec(value);
      if (global || local) {
        const key = (global || local)![1], source = global ? FlowWorker.globalVariables : this.localVariables;
        if (!Object.hasOwn(source, key)) {
          if (local && !strictMissing) return this.resolveTemplateData(value);
          if (local && this.dataGen) { const generated = this.resolveTemplateData(value); if (generated !== value) return generated; }
          throw new Error(`State Error: Assertion variable "${value}" is undefined.`);
        }
        return dataSnapshot(source[key]);
      }
      return this.resolveTemplateData(value);
    }
    if (Array.isArray(value)) return value.map(item => this.resolveTypedAssertionValue(item,strictMissing));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,this.resolveTypedAssertionValue(item,strictMissing)]));
    return value;
  }

  private resolveStepPayload(payload: any): any {
    if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) &&
        (payload.pluginMethod?.startsWith('api.') || payload.pluginMethod === 'channel.expect' || payload.pluginMethod === 'network.route' && Object.hasOwn(payload.data, 'requestBody'))) {
      const { data, ...rest } = payload;
      const resolved = this.resolveTemplateData(rest);
      const typed = new Set(['equals', 'json', 'query', 'form', 'multipart', 'requestBody']);
      resolved.data = Object.fromEntries(Object.entries(data).map(([key, value]) => [key,
        typed.has(key) ? this.resolveTypedAssertionValue(value, false) : this.resolveTemplateData(value)]));
      return resolved;
    }
    if(payload?.pluginMethod==='files.select' && payload.data && typeof payload.data==='object'){
      const result=this.resolveTemplateData(payload);if(Object.hasOwn(payload.data,'files'))result.data.files=this.resolveTypedAssertionValue(payload.data.files,false);return result;
    }
    if ((payload?.pluginMethod === 'assert.value' || payload?.pluginMethod === 'assert.that') && payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      const { data, ...rest } = payload;
      const resolved = this.resolveTemplateData(rest);
      const fields = payload.pluginMethod === 'assert.value' ? ['actual','expected'] : data.condition === 'count' || data.condition === 'values' || data.condition === 'property' && typeof data.property === 'string' && /[.\[]/.test(data.property) ? ['value'] : [];
      resolved.data = Object.fromEntries(Object.entries(data).map(([key,value]) => [key, fields.includes(key) ? this.resolveTypedAssertionValue(value,payload.pluginMethod === 'assert.value') : this.resolveTemplateData(value)]));
      return resolved;
    }
    return this.resolveTemplateData(payload);
  }

  private trackExtractionSecrets(value: any, sensitive = false, global = false): void {
    const secrets = global ? FlowWorker.extractedGlobalSecretValues : this.extractedSecretValues;
    const seen = new WeakMap<object, boolean>();
    const pending: { value: unknown; sensitive: boolean }[] = [{ value, sensitive }];
    while (pending.length) {
      const item = pending.pop()!;
      if (typeof item.value === 'string') {
        if (item.sensitive && item.value) secrets.add(item.value);
        continue;
      }
      if (typeof item.value === 'number') {
        if (item.sensitive && Number.isFinite(item.value)) secrets.add(String(item.value));
        continue;
      }
      if (item.value === null || typeof item.value !== 'object') continue;
      const previous = seen.get(item.value);
      // A shared object may first appear under an ordinary key and later under a secret key.
      if (previous === true || previous === false && !item.sensitive) continue;
      seen.set(item.value, item.sensitive);
      let descriptors: PropertyDescriptorMap;
      try { descriptors = Object.getOwnPropertyDescriptors(item.value); }
      catch { continue; } // Metadata must not make a previously valid legacy extraction fail.
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!Object.hasOwn(descriptor, 'value')) continue; // Never invoke application getters.
        pending.push({ value: descriptor.value, sensitive: item.sensitive || /password|passcode|token|secret|authorization|cookie|api.?key|otp/i.test(key) });
      }
    }
  }

  private extractFromJsonPath(obj: any, path: string): any {
    if (!obj) return undefined;
    if (!path) return obj;
    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let current = obj;
    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      current = current[part];
    }
    return current;
  }

  private processExtractions(extracts: any[]) {
    if (!extracts || extracts.length === 0) return;
    const state = this.api.getState();

    for (const ext of extracts) {
      let val;
      if (ext.target === "resBody") {
        val = this.extractFromJsonPath(state.body, ext.jsonPath);
      } else if (ext.target === "resHeader") {
        val = state.headers?.[(ext.jsonPath || "").toLowerCase()];
      } else if (ext.target === "cookie") {
        const cookies = state.headers?.["set-cookie"];
        if (Array.isArray(cookies)) {
          const match = cookies.find((c) => c.startsWith(`${ext.jsonPath}=`));
          if (match) val = match.split("=")[1].split(";")[0];
        } else if (typeof cookies === "string") {
          const match = cookies
            .split(",")
            .find((c) => c.trim().startsWith(`${ext.jsonPath}=`));
          if (match) val = match.split("=")[1].split(";")[0];
        }
      }

      if (val === undefined) {
        let debugBody = "";
        try {
          debugBody =
            typeof state.body === "object"
              ? JSON.stringify(state.body)
              : String(state.body);
        } catch {
          debugBody = "Unparseable Body";
        }
        const shortBody =
          debugBody.length > 250
            ? debugBody.substring(0, 250) + "..."
            : debugBody;
        throw new Error(
          `Extraction Failed: Could not find "${ext.jsonPath}" in the API ${ext.target}.\nThe API responded with HTTP ${state.status || "Unknown"}\nActual Body Received: ${shortBody}`,
        );
      }

      this.trackExtractionSecrets(val, ext.target === 'cookie' || /password|passcode|token|secret|authorization|cookie|api.?key|otp/i.test(ext.jsonPath || ''), !!ext.isGlobal);
      if (ext.isGlobal) FlowWorker.globalVariables[ext.variableName] = val;
      else this.localVariables[ext.variableName] = val;
    }
  }

  private emitApiTelemetry(
    method: string,
    url: string,
    headers: any,
    body: any,
  ) {
    const state = this.api.getState();
    const sharedId = Math.random().toString(36).substr(2, 9);

    const baseUrl = this.config.baseUrl || "http://localhost";
    const cleanUrl = url.startsWith("http")
      ? url
      : `${baseUrl.replace(/\/$/, "")}${url.startsWith("/") ? url : `/${url}`}`;

    let endpointName = url;
    try {
      const urlObj = new URL(cleanUrl);
      endpointName = urlObj.pathname.split("/").pop() || urlObj.pathname;
    } catch {}

    let parsedReqBody = body;
    let rawBodyString = null;
    try {
      if (typeof body === "string") {
        parsedReqBody = JSON.parse(body);
        rawBodyString = body;
      } else if (body) {
        rawBodyString = JSON.stringify(body);
      }
    } catch {
      rawBodyString = typeof body === "string" ? body : null;
    }

    let formattedHeaders: Record<string, string> = {};
    if (Array.isArray(headers)) {
      headers.forEach((h: any) => {
        if (h && h.key) formattedHeaders[h.key] = h.value;
      });
    } else if (headers && typeof headers === "object") {
      formattedHeaders = headers;
    }

    const curlString = this.web.synthesizeCurl(
      method,
      cleanUrl,
      formattedHeaders,
      rawBodyString,
    );

    this.emitLog(
      "REST",
      (state.status || 500) < 400 ? "success" : "error",
      `${method.toUpperCase()} ${endpointName}`,
      {
        method: method.toUpperCase(),
        url: cleanUrl,
        requestHeaders: formattedHeaders,
        requestBody: parsedReqBody,
        rawReplayRequest: { method: method.toUpperCase(), url: cleanUrl, headers: formattedHeaders, body: rawBodyString },
        responseStatus: state.status,
        responseHeaders: state.headers,
        responseBody: state.body,
        curlString: curlString,
      },
      sharedId,
      this.currentFileName,
    );

    this.broadcast("NETWORK_REQ", {
      id: sharedId,
      method: method.toUpperCase(),
      url: cleanUrl,
      name: endpointName,
      status: state.status,
      curlString: curlString,
      time: new Date().toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
      fileName: this.currentFileName,
    });
  }

  public async handleReplayRequest(payload: any) {
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : undefined;
    const replaySecrets = replaySecretValues(payload);
    try {
      const { url, options } = buildReplayRequest(payload);
      options.signal = AbortSignal.timeout(this.config.timeout || 30000);
      const response = await fetch(url, options);
      const text = await response.text();
      let responseBody;
      try { responseBody = JSON.parse(text); } catch { responseBody = text; }
      this.broadcast('REPLAY_RES', {
        status: response.status, responseBody: redactPayload(responseBody, replaySecrets), error: null, requestId,
        fileName: this.currentFileName,
      });
    } catch (error: any) {
      const code = error instanceof ReplayRequestError ? error.code
        : error?.name === 'TimeoutError' ? 'REPLAY_TIMEOUT' : 'REPLAY_NETWORK_ERROR';
      const message = redactText(String(error?.message || 'Replay request failed'), [this.config.machineToken || '', ...replaySecrets]);
      this.broadcast('REPLAY_RES', {
        status: null, error: code, requestId,
        responseBody: { error: message, code }, fileName: this.currentFileName,
      });
    }
  }

  public dashboardHandlesInterrupt = false;
  private requestedPause?: string;
  private inspection?: Promise<void>;
  private pendingGestures = 0;
  private resumeAfterInspection?: string;

  public requestDashboardPause(fileName: string) {
    if (this.isAborted || this.config.ci || isCIEnvironment() || fileName !== this.currentFileName || this.control.pendingPause) return;
    this.requestedPause = fileName;
  }

  private async dashboardCheckpoint() {
    if (this.isAborted || this.requestedPause !== this.currentFileName) return;
    await this.pauseForReview();
  }

  private async pauseForReview(message?: string) {
    this.requestedPause = undefined;
    let inspectable = false;
    if (!this.config.protectedHandoff && screenshotEvidence(this.config)) {
      try { inspectable = !this.web.getPage().isClosed(); } catch { /* A flow may have no open page. */ }
    }
    const prompt = message ?? (inspectable ? 'Paused from the dashboard' : 'Paused. Live inspection is unavailable for this flow.');
    await this.control.pause(prompt, {
      fileName: this.currentFileName.slice(0, 4096), scenario: this.currentScenarioName.slice(0, 4096),
      sourceLine: this.currentStepLine, stepId: this.currentStepId.slice(0, 4096), attempt: this.attempt,
      profile: (this.web.activeProfile || 'default').slice(0, 4096), inspectable
    });
  }

  public inspectPausedPage(payload: any) {
    const pause = this.control.pendingPause;
    if (!pause?.inspectable || pause.id !== payload?.pauseId || this.isAborted || this.resumeAfterInspection || this.pendingGestures >= 64) return;
    this.pendingGestures++;
    const action = (this.inspection || Promise.resolve()).then(async () => {
      if (this.isAborted || this.control.pendingPause?.id !== pause.id) return;
      const description = await interactWithPausedPage(this.web.getPage(), payload);
      if (description && this.control.pendingPause?.id === pause.id) this.broadcast('INSPECT_RESULT', { id: pause.id, description });
    }).catch(() => {
      if (this.control.pendingPause?.id === pause.id) this.broadcast('INSPECT_RESULT', { id: pause.id, description: 'This page is no longer available.' });
    }).finally(() => {
      this.pendingGestures--;
      if (this.inspection !== action) return;
      this.inspection = undefined;
      if (this.resumeAfterInspection === pause.id) this.control.resume(pause.id);
      this.resumeAfterInspection = undefined;
    });
    this.inspection = action;
  }

  public resumePause(id: string): boolean {
    if (this.inspection && this.control.pendingPause?.id === id) {
      this.resumeAfterInspection = id;
      return true;
    }
    return this.control.resume(id);
  }

  public abort(): void {
    this.isAborted = true;
    this.handoffSource?.cancel('Execution was interrupted before this file could start.');
    this.fixtureCancellation.abort(new Error('Fixture setup cancelled.'));
    this.control.cancel();
    this.api.cancelNativeRequests?.();
    this.native.events.cancelRoutes();
    this.native.applicationEvents.cancel();
  }

  public async runBatch(filesToProcess: string[], handoffSource?: HandoffWorkerSource): Promise<boolean> {
    this.batchPassed = !!handoffSource || filesToProcess.length > 0;
    const isCliHeadless = process.argv.includes("--headless");

    if (isCliHeadless) {
      this.config.headless = true;
    } else if (this.config.headless === undefined) {
      this.config.headless = false;
    }

    const ownDataPlan=this.config.nativeDataManifest===undefined;
    if(ownDataPlan)this.config.nativeDataManifest={};
    this.activeAudioPath = undefined;
    this.control.reset();
    this.workerFixtureCleanup = undefined;
    this.workerCleanupReport = undefined;
    this.handoffSource = handoffSource;
    this.handoffRunCleanup = handoffSource && new ScenarioCleanup(this.config.baseUrl);
    this.handoffRunReport = undefined;
    const previousSecrets = this.extractedSecretValues;
    const previousGlobals = FlowWorker.globalVariables;
    const previousGlobalSessions = FlowWorker.globalBrowserSessions;
    const previousGlobalSecrets = FlowWorker.extractedGlobalSecretValues;
    if (handoffSource) {
      this.extractedSecretValues = new Set(previousSecrets);
      FlowWorker.globalVariables = {};
      FlowWorker.globalBrowserSessions = {};
      FlowWorker.extractedGlobalSecretValues = new Set(previousGlobalSecrets);
    }
    this.fixtureCancellation = new AbortController();
    this.isAborted = false;
    this.api.resetCancellation?.();
    this.bailTriggered = false;
    this.isDebugHalted = false;

    const sigintHandler = async () => {
      if (this.config.ci || handoffSource || this.isSilent) { this.abort(); return; }
      if (!this.isSilent) {
        console.log(
          chalk.yellow(
            "\n[Flowstride]: Process interrupted. Gracefully shutting down...",
          ),
        );
      }
      this.abort();
      this.broadcast("SERVER_SHUTDOWN", { message: "Terminal closed." });
      try {
        await this.pendingFixtureSetup?.catch(() => {});
        await this.finishScenarioCleanup();
        await this.finishWorkerFixtures();
        await this.web.shutdown();
      } catch (e) {}
      if (!this.config.ci) process.exit(this.isAborted ? 130 : process.exitCode || 0);
    };

    if (!this.dashboardHandlesInterrupt) process.once("SIGINT", sigintHandler);

    try {
      for (const filePath of handoffSource ? [] : filesToProcess) {
        const content = fs.readFileSync(filePath, "utf8");
        let rawPath: string | undefined;
        const mightUseWorkflow = this.config.scenarioTags?.length ||
          /flow\.(?:call|fixture\.|skipIf|cleanup\.register)|^\s*Tags:/im.test(content);
        const tokens = mightUseWorkflow ? new Lexer(content).tokenise() : undefined;
        if (tokens && (this.config.scenarioTags?.length || tokens.some(isWorkflowToken))) {
          const features = prepareWorkflowFeatures(new Parser(tokens).parse(), this.config);
          rawPath = features.flatMap(feature => feature.scenarios)
            .filter(scenario => !scenario.skipReason)
            .flatMap(scenario => scenario.steps)
            .find(step => step.action === 'injectAudio')?.payload.file;
        } else {
          rawPath = content.match(/(?:flow\.)?injectAudio\s+["']([^"']+)["']/i)?.[1];
        }
        if (rawPath) {
          const absolutePath = projectPath(process.cwd(), rawPath);
          if (!fs.existsSync(absolutePath)) {
            throw new Error(
              `Pre-launch initialization failed: Audio file not found at ${absolutePath}`,
            );
          }
          this.activeAudioPath = absolutePath;
          break;
        }
      }

      const files = filesToProcess[Symbol.iterator]();
      while (!this.isAborted && !this.isDebugHalted && !this.bailTriggered) {
        const assignment = handoffSource && await handoffSource.next();
        const filePath = handoffSource ? assignment?.job.file : files.next().value;
        if (!filePath) break;
        if (this.isAborted) {
          handoffSource?.done({ passed: false });
          break;
        }
        this.handoffFile = assignment;
        this.handoffOutputs.clear();
        this.handoffFileCleanup = assignment && new ScenarioCleanup(this.config.baseUrl);
        let filePassed = true;
        const fileStartTime = Date.now();
        try {
          const fileName = flowIdentity(filePath, this.config.flowRoot);
          this.currentFileName = fileName;
          this.requestedPause = undefined;
          this.currentFlowPath = filePath;
          this.practiceFrames = undefined;
          this.config.testFile = fileName;

          this.localVariables = {}; this.dataAliases.clear(); this.currentDataCase=undefined; this.caseGroup=undefined;
          this.localBrowserSessions = {};
          this.api.resetState();
          this.dataGen = new DataGenerators();
          const content = fs.readFileSync(filePath,'utf8');
          if (assignment && createHash('sha256').update(content).digest('hex') !== assignment.job.sha256) {
            throw new Error('Flow changed after handoff planning. Start a new run.');
          }
          if (assignment) this.practiceFrames = practiceHandoffFrames(this.config, filePath, content);
          const features = assignment?.job.features ??
            prepareWorkflowFeatures(new Parser(new Lexer(content).tokenise()).parse(), this.config);
          if (assignment) {
            for (const input of Object.values(assignment.inputs)) {
              for (const secret of handoffSecrets({ value: input.value, credentials: input.protectedCredentials?.values })) {
                this.extractedSecretValues.add(secret);
              }
            }
            const audio = features.flatMap(feature => feature.scenarios).filter(scenario => !scenario.skipReason)
              .flatMap(scenario => scenario.steps).find(step => step.action === 'injectAudio');
            this.activeAudioPath = audio ? projectPath(this.config.projectRoot || process.cwd(), audio.payload.file) : undefined;
          }

          const scenarios = features.flatMap(feature => feature.scenarios);
          if (scenarios.length && scenarios.every(scenario => scenario.skipReason)) {
            for (const scenario of scenarios) this.reportSkippedScenario(scenario);
            this.broadcast('FILE_COMPLETE', { fileName, duration: Date.now() - fileStartTime });
            continue;
          }
          await this.native.dispose();
          await this.web.initialise(this.activeAudioPath);
          if (typeof this.web.getBrowserInfo === 'function') {
            const browser = this.web.getBrowserInfo();
            console.log(`[Browser]: ${browser.engine} ${browser.version}; ${browser.headless ? 'headless' : 'headed'}; ${fileName}`);
            this.broadcast('BROWSER_INFO', { ...browser, fileName });
          }
          await this.startStreaming();
          await this.setupNetworkInterception();



          const hasSessionIntent =
            scenarios.some(scenario => !scenario.skipReason &&
              scenario.steps.some(step => step.sourceFile && step.action === 'use')) ||
            content.includes("use session") ||
            content.includes("use global session");
          if (!hasSessionIntent) {
            try {
              const page = this.web.getPage();
              if (page) {
                await page
                  .context()
                  .clearCookies()
                  .catch(() => {});
                await page
                  .evaluate(() => {
                    try {
                      localStorage.clear();
                    } catch (e) {}
                    try {
                      sessionStorage.clear();
                    } catch (e) {}
                  })
                  .catch(() => {});
              }
            } catch (e) {}
          }

          if (!this.isSilent)
            console.log(
              chalk.blue.bold(`\n[Execution]: Processing file: ${fileName}`),
            );
          this.emitLog("FILE_HEADER", "info", fileName, { filePath });



          const hasOnlyMode = features.some((f) =>
            f.scenarios.some((s) => s.isOnly),
          );

          if (hasOnlyMode) {
            if (!this.isSilent) {
              console.log(
                chalk.yellow(
                  `      > [Debug Mode]: 'only.Scenario' detected. Operating in Ghost Mode.`,
                ),
              );
            }
            features.forEach((f) => {
              f.scenarios = f.scenarios.filter((s) => s.isOnly);
            });
          }

          for (const f of features) {
            if (this.isAborted || this.isDebugHalted || this.bailTriggered) break;
            if (f.scenarios.length === 0) continue;

            if (!this.isSilent)
              console.log(chalk.magenta.bold(`  Feature: ${f.name}`));
            for (const s of f.scenarios) {
              if (this.isAborted || this.isDebugHalted || this.bailTriggered) break;

              if (!this.isSilent)
                console.log(chalk.cyan(`    Scenario: ${s.name}`));

              if (s.skipReason) {
                this.reportSkippedScenario(s);
                continue;
              }
              this.currentDataCase=(s as CaseScenario).dataCase;
              this.broadcast("RUN_START", {
                scenarioName: s.name,
                fileName: this.currentFileName,
              });

              if (!await this.runPreparedScenario(s, f.declarations)) {
                filePassed = false;
                this.batchPassed = false;
              }

              if (this.isDebugHalted || this.bailTriggered) break;

              await this.web
                .getPage()
                .waitForLoadState("load", { timeout: 4000 })
                .catch(() => {});
              await this.web
                .getPage()
                .waitForLoadState("networkidle", { timeout: 4000 })
                .catch(() => {});
              if (!this.config.ci) await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          }

          if (this.isAborted) break;

          if (!this.isSilent)
            console.log(
              chalk.gray("\n[Execution]: Finalizing browser actions..."),
            );
          if (!this.config.ci) await new Promise((resolve) => setTimeout(resolve, 2000));

          await this.dashboardCheckpoint();
          await this.finishFileBrowser();

          this.broadcast("FILE_COMPLETE", {
            fileName: this.currentFileName,
            duration: Date.now() - fileStartTime,
          });
        } catch (e: any) {
          filePassed = false;
          this.batchPassed = false;
          if (this.isAborted) break;

          if (!this.isSilent)
            console.error(
              chalk.red(
                `\n[Execution]: Failed processing ${this.currentFileName}: ${redactText(runtimeFailure("file.setup",{file:this.currentFileName},e,{file:this.currentFileName}),this.secretValues())}`,
              ),
            );

          await this.finishFileBrowser();

          this.broadcast("FILE_FAILED", {
            fileName: this.currentFileName,
            duration: Date.now() - fileStartTime,
            error: runtimeFailure("file.setup",{file:this.currentFileName},e,{file:this.currentFileName}),
          });
        } finally {
          if (assignment) {
            const passed = filePassed && !this.isAborted && !this.isDebugHalted && !this.bailTriggered;
            if (this.handoffFileCleanup?.hasEntries) {
              if (passed) this.handoffFileCleanup.transferTo(this.handoffRunCleanup!);
              else if (await this.reportCleanup(this.handoffFileCleanup)) this.batchPassed = false;
            }
            handoffSource!.done({ passed, ...(passed && { outputs: Object.fromEntries(this.handoffOutputs) }) });
            if (this.isDebugHalted || this.bailTriggered) handoffSource!.cancel('Execution stopped before this file could start.');
            this.handoffFile = undefined;
            this.handoffFileCleanup = undefined;
            this.handoffOutputs.clear();
          }
        }
      }
    } finally {
      if (handoffSource) {
        if (await this.finishHandoffCleanup()) this.batchPassed = false;
        this.handoffSource = undefined;
      }
      if (await this.finishWorkerFixtures()) this.batchPassed = false;
      if (this.config.ci && this.isAborted) {
        try {
          const directory = path.join(this.config.projectRoot || process.cwd(), '.flowstride', 'artifacts');
          evidenceDirectory(this.config, directory);
          await this.native.dispose();
          await this.web.shutdown(this.config.protectedHandoff || this.config.recordVideo === false ? undefined : prepareEvidenceFile(this.config, path.join(directory, videoFileName(this.currentFileName))));
          protectEvidenceTree(this.config, directory);
        } catch (error: any) { this.broadcast('WORKER_ERROR', { message: error.message }); }
      }
      process.removeListener("SIGINT", sigintHandler);
      if(ownDataPlan)delete this.config.nativeDataManifest;
      if (handoffSource) {
        this.localVariables = {};
        this.localBrowserSessions = {};
        this.dataAliases.clear();
        this.commandSecretValues = [];
        this.extractedSecretValues = previousSecrets;
        FlowWorker.globalVariables = previousGlobals;
        FlowWorker.globalBrowserSessions = previousGlobalSessions;
        FlowWorker.extractedGlobalSecretValues = previousGlobalSecrets;
        this.handoffRunCleanup = undefined;
        this.handoffRunReport = undefined;
        this.caseGroup = undefined;
        this.api.resetState();
        this.store.clear?.();
      }
    }
    if (!this.config.ci && !this.isSilent && !this.isAborted) {
      if (this.isDebugHalted) {
        console.log(
          chalk.cyan("\n[Execution]: Test suite halted by debug flag."),
        );
      } else {
        console.log(
          this.batchPassed ? chalk.green("\n[Execution]: All suites completed successfully.") : chalk.red("\n[Execution]: Test suite failed. Review the diagnostics above."),
        );
      }
    }
    return this.batchPassed && !this.isAborted && !this.isDebugHalted;
  }

  private async runScenarioWithRetries(scenario: ScenarioNode, declarations: DeclarationNode[]) {
    this.maxAttempts = (this.config.retries || 0) + 1;
    const baseline = this.maxAttempts > 1 ? await this.web.checkpointProfiles() : undefined;
    const variables = this.maxAttempts > 1 ? structuredClone(this.localVariables) : {}, sessions = this.maxAttempts > 1 ? structuredClone(this.localBrowserSessions) : {};
    const globals = this.maxAttempts > 1 ? structuredClone(FlowWorker.globalVariables) : {}, globalSessions = this.maxAttempts > 1 ? structuredClone(FlowWorker.globalBrowserSessions) : {};
    const storeState = this.maxAttempts > 1 ? structuredClone(this.store.getAll?.()) : undefined;
    const apiState = this.maxAttempts > 1 ? this.api.checkpointState?.() : undefined;
    const generatorState=this.maxAttempts>1?this.dataGen?.checkpoint():undefined;
    const dataAliases=this.maxAttempts>1?[...this.dataAliases]:[];
    let finalPassed = false;
    for (this.attempt = 1; this.attempt <= this.maxAttempts; this.attempt++) {
      if (this.isAborted || this.isDebugHalted) break;
      if (this.attempt > 1) {
        await this.native.dispose(); if (apiState) this.api.restoreState(apiState); else this.api.resetState();
        this.localVariables = structuredClone(variables); this.localBrowserSessions = structuredClone(sessions);
        FlowWorker.globalVariables = structuredClone(globals); FlowWorker.globalBrowserSessions = structuredClone(globalSessions);
        if (storeState) { this.store.clear(); for (const [key,value] of Object.entries(structuredClone(storeState))) this.store.set(key,value); }
        await this.web.restoreProfiles(baseline);
        this.dataAliases=new Set(dataAliases);
        if(generatorState && this.dataGen?.isSeeded())this.dataGen.restore(generatorState);
      }
      const started = Date.now();
      this.broadcast('SCENARIO_ATTEMPT', { fileName: this.currentFileName, scenario: scenario.name, attempt: this.attempt });
      const errorIndex = this.web.pageErrors?.length || 0;
      if (scenario.steps.some(step => step.action === 'fixture' ||
          step.action === 'native' && step.payload.pluginMethod.toLowerCase() === 'cleanup.register')) {
        this.activeCleanup = new ScenarioCleanup(this.config.baseUrl);
        this.cleanupReport = undefined;
      }
      this.attemptHandoffs.clear();
      this.publishesInAttempt = this.handoffSource ? new Set(scenario.steps
        .filter(step => step.action === 'handoff' && step.payload.kind === 'publish')
        .map(step => step.payload.name)) : undefined;
      let completed = false;
      let cleanupFailed = false;
      let retained: ScenarioCleanup | undefined;
      try {
        completed = await this.runScenario(structuredClone(scenario), declarations);
      } finally {
        try {
          await this.native.applicationEvents.dispose();
        } finally {
          try {
            if (completed && !this.isAborted && this.attemptHandoffs.size && this.activeCleanup) {
              retained = new ScenarioCleanup(this.config.baseUrl);
              this.activeCleanup.transferTo(retained, new Set(this.attemptHandoffs.keys()));
            }
            cleanupFailed = await this.finishScenarioCleanup();
          } finally {
            this.restoreFixtureBindings();
            this.activeCleanup = undefined;
            this.cleanupReport = undefined;
          }
        }
      }
      const browserErrors = this.web.pageErrors?.slice(errorIndex).filter(Boolean) || [];
      const passed = completed && !cleanupFailed && (this.config.browserErrors === 'record' || !browserErrors.length);
      if (passed && !this.isAborted && !this.isDebugHalted && !(this.config.failOnFlaky && this.attempt > 1)) {
        if (retained?.hasEntries) retained.transferTo(this.handoffFileCleanup!);
        for (const [name, output] of this.attemptHandoffs) this.handoffOutputs.set(name, output);
      } else if (retained?.hasEntries) {
        cleanupFailed = await this.reportCleanup(retained) || cleanupFailed;
      }
      this.attemptHandoffs.clear();
      this.publishesInAttempt = undefined;
      if (cleanupFailed && this.config.bail && !this.bailTriggered) {
        this.bailTriggered = true;
        this.broadcast('BAIL', { fileName: this.currentFileName });
      }
      if (this.config.browserErrors !== 'record') for (const message of browserErrors) {
        const error = runtimeFailure('browser.pageError',{},new Error(message),{file:this.currentFileName,profile:this.web.activeProfile || 'default'});
        this.emitLog('ERROR','error',error,{rawError:error,command:'browser.pageError'},undefined,this.currentFileName);
        if (!this.isSilent) console.error(redactText(error,this.secretValues()));
      }
      this.broadcast('SCENARIO_RESULT', { fileName: this.currentFileName, scenario: scenario.name, attempt: this.attempt, status: this.isAborted ? 'interrupted' : passed ? 'passed' : 'failed', flaky: passed && this.attempt > 1, browserErrors, duration: Date.now() - started });
      finalPassed = passed && !(this.config.failOnFlaky && this.attempt > 1);
      if (passed || cleanupFailed || this.isAborted || this.isDebugHalted) break;
      if (this.attempt < this.maxAttempts) this.web.pageErrors?.splice(errorIndex);
    }
    this.attempt = 1; this.maxAttempts = 1;
    return finalPassed;
  }

  private async runScenario(
    scenario: ScenarioNode,
    globalDeclarations: DeclarationNode[] = [],
  ) {
    let hasScenarioFailed = false;
    let hasHardFailure = false;
    let lastFailedStepId: string | undefined;
    this.paceMilliseconds = 0;
    this.currentScenarioName = scenario.name;
    const scopes = new ScopedBrowser(() => this.web.getScope(), () => this.web.getPage(), this.config.timeout);
    const visitedStepIds = new Set<string>();
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = structuredClone(scenario.steps[i]);
      if (!hasHardFailure) step.id += scopes.iterationId;
      if (hasHardFailure && visitedStepIds.has(step.id)) continue;
      visitedStepIds.add(step.id);
      this.currentAssertion = undefined;
      this.commandSecretValues = [];
      if (this.isAborted) break;

      const blockName = step.blockDescription.split(" ")[0];
      let blockDesc = step.blockDescription.substring(blockName.length).trim();

      const stepLabel = commandLabel(step.action, step.payload);
      const method = step.action === 'native' ? step.payload.pluginMethod.toLowerCase() : '';
      const isCleanup = method === 'cleanup.register';
      if (hasHardFailure) {
        const assertion=unexecutedAssertion(step.action,step.payload);
        this.broadcast('STEP_ADD',{id:step.id,type:blockName,description:blockDesc,command:step.action,commandLabel:stepLabel,sourceLine:step.line,status:'not_tested',fileName:this.currentFileName});
        this.broadcast('STEP_UPDATE',{id:step.id,status:'not_tested',assertion,error:null,commandLabel:stepLabel,sourceLine:step.line,fileName:this.currentFileName});
        continue;
      }

      await this.dashboardCheckpoint();
      if (this.isAborted) break;
      let resolutionError: unknown;
      try {
      blockDesc = this.resolveTemplateData(blockDesc);
      if(this.currentDataCase)blockDesc+=` · Case ${this.currentDataCase.index+1}/${this.currentDataCase.total}`;

      if (isCleanup) {
        const data = cleanupRegistration(step.payload.data);
        step.payload.data = { ...data, url: resolveCleanupTarget(data.url, component => this.resolveTemplateData(component)) };
      } else {
        if (step.action === 'handoff') {
          const command: HandoffCommand = step.payload;
          if (command.kind === 'publish') {
            command.value = this.resolveTypedAssertionValue(command.value);
            if (command.credentials) {
              command.credentials = Object.fromEntries(Object.entries(command.credentials)
                .map(([key, reference]) => [key, this.resolveTypedAssertionValue(reference)]));
              for (const value of Object.values(command.credentials)) {
                if (typeof value === 'string') this.extractedSecretValues.add(value);
              }
            }
          }
        } else if (step.action === 'helper' || step.action === 'fixture') {
          const args = (step.payload as HelperCallPayload).args.map(arg => this.resolveTypedAssertionValue(arg, false));
          step.payload.args = step.action === 'fixture' ? dataSnapshot(args) : args;
        } else {
          step.payload = this.resolveStepPayload(step.payload);
        }
      }

      } catch (error) { resolutionError = error; }
      this.commandSecretValues = commandSecrets(step.action,step.payload);

      this.currentStepContext = `${blockName} ${blockDesc}`;

      const isOpt = step.payload?.optional && step.payload.soft === undefined;
      const isSoft = step.payload?.soft === true && !step.payload?.optional && isSoftAssertionStep(step.action, step.payload);
      this.currentStepId = step.id;
      this.currentStepLine = step.line;



      const mockSpinner = {
        text: "",
        start() {
          return this;
        },
        succeed() {
          return this;
        },
        fail() {
          return this;
        },
        warn() {
          return this;
        },
        render() {
          return this;
        },
      };

      const spinner = this.isSilent
        ? mockSpinner.start()
        : ora({
            text: `${chalk.blue.bold(blockName)} ${chalk.white(blockDesc)} ${isOpt ? chalk.gray("(Optional)") : ""}`,
            indent: 6,
          }).start();

      this.emitLog(
        "ACTION",
        "info",
        `${blockName}: ${blockDesc}`,
        {
          command: step.action,
          commandLabel: stepLabel,
          sourceFile: step.sourceFile,
          sourceLine: step.line,
          payload: isCleanup || step.action === 'helper' || step.action === 'fixture' || step.action === 'handoff' ? undefined : step.payload,
        },
        undefined,
        this.currentFileName,
      );

      this.broadcast("STEP_ADD", {
        id: step.id,
        type: blockName as any,
        description: blockDesc,
        command: step.action,
          commandLabel: stepLabel,
          sourceFile: step.sourceFile,
          sourceLine: step.line,
        soft: isSoft,
        userMessage: ['log','pause'].includes(step.action) ? step.payload?.message : undefined,
        status: "running",
        error: null, assertion: null,
        fileName: this.currentFileName,
      });

      const stepStarted = Date.now();
      try {
        if (resolutionError) throw resolutionError;
        if (isCleanup) {
          this.activeCleanup!.register(step, step.payload.data, this.api.snapshotHeaders());
        } else if (step.action === 'handoff') {
          this.executeHandoff(step.payload);
        } else if (step.action === 'fixture') {
          const pending = this.executeFixture(step.payload, globalDeclarations, step);
          this.pendingFixtureSetup = pending;
          try {
            await pending;
          } finally {
            this.pendingFixtureSetup = undefined;
          }
        } else if (step.action === 'scoped') {
          const next = await scopes.execute(step.payload, i, result => { this.currentAssertion = result; });
          if (next !== undefined) i = next - 1;
        } else if (method !== 'skipif') {
          await this.executeStep(
            step.action,
            step.payload,
            scenario.declarations,
            globalDeclarations,
          );
        }

        const stepContext = await this.captureStepContext(step.payload);
        const domSnapshot = await this.native.captureDOM(step.id).catch(() => undefined);
        spinner.succeed();
        const assertion=this.assertionForStep(step);
        this.printAssertion(assertion);
        this.broadcast("STEP_UPDATE", {
          id: step.id,
          status: "passed",
          error: null,
          assertion,
          screenshot: stepContext.screenshot,
          domSnapshot,
          fileName: this.currentFileName,
        });

        await this.dashboardCheckpoint();
        if (step.isStop) {
          if (!this.isSilent) {
            console.log(
              chalk.cyan(
                `      > [Execution]: Debug stop triggered. Halting global execution.`,
              ),
            );
          }
          this.isDebugHalted = true;
          break;
        }
      } catch (e: any) {
        if (this.isAborted) break;
        const assertion=this.assertionForStep(step);

        const stepContext = await this.captureStepContext(step.payload);
        const domSnapshot = await this.native.captureDOM(step.id).catch(() => undefined);

        let strippedDom = "";
        try {
          const page = this.web.getPage();
          if (page && !this.config.protectedHandoff) {
            strippedDom = await DOMStripper.getStrippedHTML(page);
          }
        } catch (domErr) {
          if (!this.isSilent)
            console.warn(
              chalk.yellow(
                `\n[Warning]: Could not extract stripped DOM: ${domErr}`,
              ),
            );
        }

        if (isOpt) {
          spinner.warn(chalk.yellow(`[Skipped]: ${blockDesc}`));
          this.emitLog(
            "ACTION",
            "info",
            `Skipped Optional Step: ${blockDesc}`,
            {
              reason: runtimeFailure(stepLabel,step.payload,e,{file:this.currentFileName,line:step.line}),
              strippedDom,
            },
            undefined,
            this.currentFileName,
          );
          this.broadcast("STEP_UPDATE", {
            id: step.id,
            status: "skipped",
            error:runtimeFailure(stepLabel,step.payload,e,{file:this.currentFileName,line:step.line}),
            assertion,
            screenshot: stepContext.screenshot,
            domSnapshot,
            fileName: this.currentFileName,
          });
          continue;
        }

        const isUIAction = [
          "click",
          "hover",
          "type",
          "forceClick",
          "forceType",
          "check",
          "uncheck",
          "select",
          "drag",
          "set",
        ].includes(step.action);

        const errorString = String(e.message || "");
        const isSelectorError =
          errorString.includes("Timeout") ||
          errorString.includes("Ambiguity") ||
          errorString.includes("intercepted") ||
          errorString.includes("not found") ||
          errorString.includes("failed to find");

        if (
          isUIAction &&
          isSelectorError &&
          strippedDom &&
          step.payload?.selector
        ) {
          spinner.fail();
          if (!this.isSilent) {
            console.log(
              chalk.magenta(
                `\n      > [AI Healing]: Auto-healing broken selectors is a Flowstride Enterprise feature.`,
              ),
            );
            console.log(
              chalk.magenta(
                `      > Visit flowstride.io to upgrade and let AI fix broken tests automatically.\n`,
              ),
            );
          }
        } else {
          spinner.fail();
        }

        const humanReadableError = assertion ? assertionText(assertion) : runtimeFailure(stepLabel,isCleanup ? {} : step.payload,e,{file:step.sourceFile || this.currentFileName,line:step.line,profile:this.web.activeProfile || "default",timeout:this.config.timeout,elapsed:Date.now()-stepStarted});
        this.printAssertion(assertion);
        if (!this.isSilent && !assertion) console.error('      '+redactText(String(humanReadableError),this.secretValues()).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,''));

        this.emitLog(
          "ERROR",
          "error",
          humanReadableError,
          {
            rawError: humanReadableError,
            stepId: step.id,
            assertion,
            command: step.action,
          commandLabel: stepLabel,
          sourceFile: step.sourceFile,
          sourceLine: step.line,
            screenshot: stepContext.screenshot,
            boundingBox: stepContext.boundingBox,
            strippedDom,
          },
          undefined,
          this.currentFileName,
        );

        this.broadcast("STEP_UPDATE", {
          id: step.id,
          status: "failed",
          error: humanReadableError,
          assertion,
          screenshot: stepContext.screenshot,
          domSnapshot,
          fileName: this.currentFileName,
        });
        hasScenarioFailed = true;
        lastFailedStepId = step.id;
        if (!isSoft) hasHardFailure = true;
        if (!isSoft && this.config.bail && this.attempt >= this.maxAttempts && !this.bailTriggered) {
          this.bailTriggered = true;
          this.broadcast('BAIL', { fileName: this.currentFileName, id: step.id });
        }
      }
    }
    // Soft checks complete the scenario before --bail can stop subsequent scenarios/files.
    if (hasScenarioFailed && this.config.bail && this.attempt >= this.maxAttempts && !this.bailTriggered) {
      this.bailTriggered = true;
      this.broadcast('BAIL', { fileName: this.currentFileName, id: lastFailedStepId });
    }
    return !hasScenarioFailed;
  }

  private async waitForPipeline(): Promise<void> {
    if (!this.activeAudioPath || !fs.existsSync(this.activeAudioPath)) {
      throw new Error(
        "Wait Error: No active audio file was injected to wait for.",
      );
    }

    try {
      const buffer = Buffer.alloc(44);
      const fileDescriptor = fs.openSync(this.activeAudioPath, "r");
      fs.readSync(fileDescriptor, buffer, 0, 44, 0);
      fs.closeSync(fileDescriptor);

      const byteRate = buffer.readUInt32LE(28);
      const fileSize = fs.statSync(this.activeAudioPath).size;
      const dataSize = fileSize - 44;

      let durationSeconds = dataSize / byteRate;

      if (
        !durationSeconds ||
        durationSeconds < 0 ||
        !isFinite(durationSeconds)
      ) {
        durationSeconds = 10;
      }

      const waitTimeMs = Math.max(0, Math.ceil(durationSeconds * 1000) - 500);

      if (!this.isSilent)
        console.log(
          chalk.gray(
            `\n      > Detected stream duration: ${durationSeconds.toFixed(1)}s.`,
          ),
        );
      if (!this.isSilent)
        console.log(
          chalk.gray(`      > Pausing runner for ${waitTimeMs}ms...`),
        );

      await new Promise((resolve) => setTimeout(resolve, waitTimeMs));

      if (!this.isSilent)
        console.log(
          chalk.gray(
            `      > Stream finished. Proceeding immediately to click Stop...`,
          ),
        );
    } catch (error: any) {
      throw new Error(`Failed to synchronize media pipeline: ${error.message}`);
    }
  }

  private executeHandoff(command: HandoffCommand): void {
    if (!this.handoffFile) throw new Error('Handoff commands require a coordinated run.');
    if (command.kind === 'publish') {
      const output = snapshotHandoff(command.value, command.credentials);
      for (const secret of handoffSecrets(output)) this.extractedSecretValues.add(secret);
      this.attemptHandoffs.set(command.name, output);
      return;
    }
    if (!Object.hasOwn(this.handoffFile.inputs, command.name)) throw new Error('The required handoff is unavailable.');
    const input = this.handoffFile.inputs[command.name]!;
    this.bindAttemptData(command.as, structuredClone(input.value));
    if (command.credentialsAs) {
      if (!input.protectedCredentials?.values) throw new Error('The required protected credentials are unavailable.');
      this.bindAttemptData(command.credentialsAs, structuredClone(input.protectedCredentials.values));
    }
  }

  private bindAttemptData(name: string, value: unknown): void {
    if (!this.fixtureBindings.has(name)) {
      this.fixtureBindings.set(name, { previous: Object.getOwnPropertyDescriptor(this.localVariables, name), wasAlias: this.dataAliases.has(name) });
    }
    for (const secret of dataSecrets(value, isSensitiveField(name))) this.extractedSecretValues.add(secret);
    Object.defineProperty(this.localVariables, name, { value, enumerable: true, writable: true, configurable: true });
    this.dataAliases.add(name);
  }

  private resolveHelper(binding: DeclarationNode) {
    const helper = resolveProjectHelper(this.config, this.currentFlowPath, binding);
    // Use the checked bundled module for the entire captured run. Edits take effect on the next run.
    if (this.practiceFrames?.specifier === helper.specifier && this.practiceFrames.helper) {
      helper.file = this.practiceFrames.helper;
    }
    return helper;
  }

  private async executeFixture(call: FixtureCallPayload, declarations: DeclarationNode[], step: StepNode) {
    const binding = declarations.find(item => item.kind === 'helper' && item.alias === call.name);
    if (!binding) throw new Error(`Fixture "${call.name}" must be imported under Feature.`);
    const helper = this.resolveHelper(binding);
    const workerKey = call.scope === 'worker' ? JSON.stringify([helper.file, helper.name, call.args]) : undefined;
    const origin: FixtureCleanup = {
      name: call.name,
      scope: call.scope,
      fileName: this.currentFileName,
      sourceLine: step.line,
      scenario: this.currentScenarioName,
      attempt: this.attempt,
    };
    this.fixtureCancellation.signal.throwIfAborted();
    const value = workerKey !== undefined && this.workerFixtureValues.has(workerKey)
      ? this.workerFixtureValues.get(workerKey)
      : await this.startFixture(helper, call, origin, workerKey);
    if (call.capture) {
      const { name } = call.capture;
      if (value === undefined) throw new Error(`Fixture "${call.name}" must return plain JSON data to use as "${name}".`);
      this.bindAttemptData(name, workerKey === undefined ? value : structuredClone(value));
    }
  }

  private async startFixture(
    helper: ReturnType<typeof resolveProjectHelper>,
    call: FixtureCallPayload,
    origin: FixtureCleanup,
    workerKey: string | undefined,
  ): Promise<unknown> {
    const signal = this.fixtureCancellation.signal;
    const releases: FixtureRelease[] = [];
    const profiles = call.scope === 'attempt' ? new Map<string, unknown>() : undefined;
    let cleanup = this.activeCleanup!;
    try {
      const result = await setupFixture(this.config, signal, releases, profiles,
        fixture => invokeProjectHelper(helper, () => {
          fixture.signal.throwIfAborted();
          return [fixture, ...call.args];
        }), call.scope === 'attempt' ? this.publishesInAttempt : undefined,
        call.scope === 'attempt' ? origin.attempt : undefined);
      if (profiles?.size) await this.createFixtureProfiles(profiles, signal, releases);
      signal.throwIfAborted();

      let value: unknown;
      if (call.capture || workerKey !== undefined && result !== undefined) {
        try {
          value = dataSnapshot(result);
        } catch (error) {
          throw new Error(`Fixture "${call.name}" must return plain JSON data for use in the flow or across scenarios.`, { cause: error });
        }
        for (const secret of dataSecrets(value)) this.extractedSecretValues.add(secret);
      }
      if (workerKey !== undefined) {
        this.workerFixtureValues.set(workerKey, value);
        cleanup = this.workerFixtureCleanup ??= new ScenarioCleanup(this.config.baseUrl);
      }
      return value;
    } finally {
      const secrets = this.commandSecretValues.slice();
      for (const { release, handoff } of releases) {
        cleanup.defer(origin, async signal => {
          try {
            await release(signal);
          } catch (error) {
            const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Callback rejected with a non-Error value.';
            throw new Error(redactText(detail, secrets));
          }
        }, handoff);
      }
    }
  }

  private async createFixtureProfiles(profiles: Map<string, unknown>, signal: AbortSignal, releases: FixtureRelease[]) {
    const previous = this.web.activeProfile;
    try {
      for (const [name, options] of profiles) {
        signal.throwIfAborted();
        await this.native.execute('browser.create', { name, options });
        // A test may explicitly close the profile and reuse the name.
        const context = this.web.profileContext(name);
        releases.push({ release: async () => {
          if (context && this.web.profileContext(name) === context) await this.native.execute('browser.close', { name });
        } });
      }
    } finally {
      if (this.web.activeProfile !== previous) await this.native.execute('browser.use', { name: previous });
    }
  }

  private restoreFixtureBindings(): void {
    for (const [name, { previous, wasAlias }] of this.fixtureBindings) {
      if (previous) Object.defineProperty(this.localVariables, name, previous);
      else delete this.localVariables[name];
      if (wasAlias) this.dataAliases.add(name);
      else this.dataAliases.delete(name);
    }
    this.fixtureBindings.clear();
  }

  private async executeStep(
    action: string,
    payload: any,
    localDeclarations: DeclarationNode[] = [],
    globalDeclarations: DeclarationNode[] = [],
  ) {
    if (payload?.soft !== undefined && (payload.soft !== true || payload.optional || !isSoftAssertionStep(action, payload))) {
      throw new Error('flow.soft requires a supported built-in assertion and cannot be combined with flow.try.');
    }
    if (this.paceMilliseconds && ['open','click','forceClick','type','forceType','passcode','upload','set','select','drag','switchTo','close','acceptDialog','rejectDialog','check','uncheck','hover','injectAudio','press','clear','focus','blur','doubleClick','rightClick','goBack','goForward','reload','scroll'].includes(action) || this.paceMilliseconds && action === 'native' && ['input.type','tab.use','tab.close','frame.use','frame.main','files.select'].includes(payload?.pluginMethod)) {
      await this.control.delay(this.paceMilliseconds);
    }
    if (payload && payload.selector === "smart-burger-fallback") {
      payload.selector = [
        'button[aria-label*="menu" i]',
        '[aria-label*="menu" i]',
        '[title*="menu" i]',
        ".bm-burger-button",
        '[class*="hamburger" i]',
        '[class*="burger" i]',
        '[id*="hamburger" i]',
        '[id*="burger" i]',
      ].join(", ");
    }

    if (action === 'expect') validateExpectationType(payload?.type);

    switch (action) {
      case 'press': case 'clear': case 'focus': case 'blur': case 'doubleClick': case 'rightClick': case 'goBack': case 'goForward': case 'reload':
        await this.native.interactions.simple(action, payload);
        break;
      case 'scroll':
        await this.native.interactions.scroll(payload.data);
        break;

      case 'wait':
        await this.control.delay(validateControlDuration(payload?.milliseconds, 'wait')!);
        break;
      case 'pace':
        this.paceMilliseconds = validateControlDuration(payload?.milliseconds, 'pace')!;
        break;
      case 'log': {
        validateControlMessage(payload?.message, 'log');
        const message = redactText(payload.message, this.secretValues());
        // Prevent a user message from forging terminal statuses or injecting ANSI commands.
        const terminalMessage = message.replace(/[\x00-\x1f\x7f-\x9f]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
        if (!this.isSilent) console.log('      [Log]: ' + terminalMessage);
        this.emitLog('CONSOLE', 'info', message, { userLog: true, stepId: this.currentStepId, scenario: this.currentScenarioName, sourceLine: this.currentStepLine });
        break;
      }
      case 'pause': {
        if (this.config.ci || isCIEnvironment()) throw new Error('flow.pause requires the interactive Flowstride dashboard and cannot run in CI. Remove the pause before running unattended tests.');
        validateControlMessage(payload?.message, 'pause');
        await this.pauseForReview(payload.message);
        break;
      }
      case 'native': {
        const timeout = nativeStepTimeout(payload.pluginMethod, payload.data, this.config.timeout);
        let result: unknown;
        try {
          if (payload.pluginMethod.startsWith('api.')) {
            this.native.lastAssertion = undefined;
            await this.api.executeNative(payload.pluginMethod.slice(4), payload.data, assertion => {
              this.native.lastAssertion = assertion;
            });
          } else if (/^(?:console|channel)\.expect$/.test(payload.pluginMethod)) {
            result = await this.native.execute(payload.pluginMethod, payload.data);
          } else if(/^(?:data|file)\./.test(payload.pluginMethod)){
            this.native.lastAssertion=undefined;result=await withDeadline(this.executeDataStep(payload.pluginMethod,payload.data),timeout);
          }else result = await withDeadline(this.native.execute(payload.pluginMethod, payload.data), timeout);
          this.currentAssertion = this.native.lastAssertion;
        } catch (error: any) {
          const fallback = unexecutedAssertion('native',payload,'The assertion could not execute.');
          if (fallback) { fallback.status='failed';fallback.checks.push({key:'execution',label:'Assertion execution',status:'failed',reason:String(error.message||error)}); }
          this.currentAssertion = failedAssertion(error.assertion || this.native.lastAssertion || fallback, String(error.message||error));
          throw error;
        }
        if (payload.saveAs) this.localVariables[payload.saveAs] = result;
        break;
      }
      case "extract":
        if (payload.target === 'property' || payload.target === 'network') {
          if (typeof payload.variableName !== 'string' || !/^[A-Za-z_]\w{0,127}$/.test(payload.variableName) || ['__proto__','constructor','prototype'].includes(payload.variableName)) throw new Error('Extraction requires a safe variable name of 1–128 characters.');
          let value: unknown, sensitive = false;
          if (payload.target === 'network') {
            value = this.native.events.extractNetwork(payload.captureName, payload.jsonPath);
            sensitive = /password|passcode|token|secret|authorization|cookie|api.?key|otp/i.test(payload.jsonPath);
          } else {
            let locator: Awaited<ReturnType<WebAdapter['resolvePropertyTarget']>> | undefined;
            let observed = 'Target not found';
            try {
              await poll(async () => {
                if (this.isAborted) return true;
                try { locator = await this.web.resolvePropertyTarget(payload.selector, payload.elementType, payload.readableTarget); }
                catch (error) { observed = String(error instanceof Error ? error.message : error); throw error; }
                const count = await locator.count(); observed = `${count} matching target(s)`;
                return count === 1;
              },this.config.timeout || 30000,'property extraction target');
            } catch (error) { throw new Error(`Property extraction requires exactly one target: ${observed}. Narrow the readable target with a qualifier, spatial relationship, or explicit selector.`,{cause:error}); }
            if (this.isAborted) throw new Error('Property extraction cancelled.');
            value = await readBrowserProperty(locator!, payload.property);
            sensitive = /password|passcode|token|secret|authorization|cookie|api.?key|otp/i.test(payload.property);
            sensitive ||= await locator!.evaluate(element => /password|passcode|token|secret|authorization|cookie|api.?key|one-time-code|otp/i.test(['type','name','id','autocomplete'].map(key => element.getAttribute(key) || '').join(' ')));
          }
          this.trackExtractionSecrets(value,sensitive,!!payload.isGlobal);
          Object.defineProperty(payload.isGlobal ? FlowWorker.globalVariables : this.localVariables,payload.variableName,{value:dataSnapshot(value),enumerable:true,writable:true,configurable:true});
          break;
        }
        if (["resBody", "resHeader", "cookie"].includes(payload.target)) {
          this.processExtractions([
            {
              target: payload.target,
              jsonPath: payload.jsonPath,
              variableName: payload.variableName,
              isGlobal: payload.isGlobal,
            },
          ]);
        } else {
          let extractedString = "";

          if (payload.target === "text") {
            extractedString = await this.web.extractText(
              payload.selector,
              payload.elementType,
            );
          } else if (payload.target === "value") {
            extractedString = await this.web.extractValue(
              payload.selector,
              payload.elementType,
            );
          } else if (payload.target === "attribute") {
            const val = await this.web.getAttribute(
              payload.selector,
              payload.attribute,
              payload.elementType,
            );
            extractedString = val || "";
          }

          if (payload.isGlobal) {
            FlowWorker.globalVariables[payload.variableName] = extractedString;
          } else {
            this.localVariables[payload.variableName] = extractedString;
          }
        }
        break;

      case "getOtp":
        if (!this.isSilent) {
          console.log(
            chalk.magenta(
              `\n      > [Notice]: Automated OTP extraction is a Flowstride Enterprise feature.`,
            ),
          );
          console.log(
            chalk.magenta(
              `      > Visit flowstride.io to start your 60-day free trial (up to 1000 free runs).`,
            ),
          );
          console.log(
            chalk.magenta(
              `      > You can cancel at any time before the 61st day.\n`,
            ),
          );
        }
        throw new Error(
          "FlowMail Error: Automated OTP extraction requires Flowstride Enterprise. Visit flowstride.io to start your 60-day free trial.",
        );

      case 'helper': {
        const call: HelperCallPayload = payload;
        const binding = globalDeclarations.find(item => item.kind === 'helper' && item.alias === call.name);
        if (!binding) throw new Error(`Helper "${call.name}" must be imported under Feature.`);
        const result = await withDeadline(
          callProjectHelper(this.config, this.currentFlowPath, binding, call, () => this.web.getPage(), this.resolveHelper(binding)),
          this.config.timeout,
        );
        if (call.capture && !this.isAborted) {
          const { name, isGlobal } = call.capture;
          let value: unknown;
          try {
            value = dataSnapshot(result);
          } catch (error) {
            throw new Error(`Cannot save the return value of "${call.name}" as "${name}". Return plain JSON data.`, { cause: error });
          }
          const secrets = isGlobal ? FlowWorker.extractedGlobalSecretValues : this.extractedSecretValues;
          for (const secret of dataSecrets(value, isSensitiveField(name))) secrets.add(secret);
          const variables = isGlobal ? FlowWorker.globalVariables : this.localVariables;
          Object.defineProperty(variables, name, { value, enumerable: true, writable: true, configurable: true });
          if (!isGlobal) this.dataAliases.add(name);
        }
        break;
      }

      case "plugin":
        if (!this.pluginManager) {
          throw new Error(
            `Framework Error: PluginManager is not instantiated.`,
          );
        }

        const alias = payload.pluginAlias;
        const method = payload.pluginMethod;

        let resolvedPath = localDeclarations.find(
          (d) => d.kind !== "helper" && d.alias === alias,
        )?.path;

        if (!resolvedPath) {
          resolvedPath = globalDeclarations.find(
            (d) => d.kind !== "helper" && d.alias === alias,
          )?.path;
        }

        if (!resolvedPath) {
          throw new Error(
            `Scoping Error: You tried to use the alias "${alias}" without registering it. Please add 'let ${alias} = "path/to/plugin.ts"' at the top of your scenario or feature.`,
          );
        }

        const cleanPath = resolvedPath
          .replace(/^['"]|['"]$/g, "")
          .replace(/\.ts$/, "");
        const executableTarget = `${cleanPath}.${method}`;
        await this.pluginManager.execute(executableTarget, payload.data);
        break;

      case "post":
      case "get":
      case "put":
      case "patch":
      case "delete":
        const verb = action.toLowerCase() as
          | "get"
          | "post"
          | "put"
          | "patch"
          | "delete";
        const baseUrl = this.config.baseUrl || "http://localhost";
        this.lastApiUrl = payload.url.startsWith("http")
          ? payload.url
          : `${baseUrl.replace(/\/$/, "")}${payload.url.startsWith("/") ? payload.url : `/${payload.url}`}`;

        if (verb === "get" || verb === "delete") {
          await this.api[verb](payload.url, payload.headers);
        } else {
          await this.api[verb](payload.url, payload.headers, payload.body);
        }
        this.emitApiTelemetry(verb, payload.url, payload.headers, payload.body);
        this.processExtractions(payload.extract);
        break;

      case "graphql":
        const gqlBaseUrl = this.config.baseUrl || "http://localhost";
        this.lastApiUrl = payload.url.startsWith("http")
          ? payload.url
          : `${gqlBaseUrl.replace(/\/$/, "")}${payload.url.startsWith("/") ? payload.url : `/${payload.url}`}`;

        await this.api.graphql(payload.url, payload.headers, payload.body);
        this.emitApiTelemetry(
          "graphql",
          payload.url,
          payload.headers,
          payload.body,
        );
        this.processExtractions(payload.extract);
        break;

      case "autoHeal":
        throw new Error(
          "Error: flow.autoheal is a Flowstride Enterprise feature. Visit flowstride.io to upgrade.",
        );

      case "save":
        if (payload.type === "session") {
          const stateToSave = await this.web.getState();
          let apiCookies: any[] = [];
          try {
            const apiState = this.api.getLegacySessionState ? this.api.getLegacySessionState() : this.api.getState();
            if (
              apiState &&
              apiState.headers &&
              apiState.headers["set-cookie"]
            ) {
              const rawCookies = apiState.headers["set-cookie"];
              apiCookies = Array.isArray(rawCookies)
                ? rawCookies
                : [rawCookies];
            }
          } catch (e) {}

          let fallbackDomain: string | undefined = undefined;
          try {
            if (this.lastApiUrl) {
              fallbackDomain = new URL(this.lastApiUrl).hostname;
            }
          } catch (e) {}

          const hybridState = {
            cookies: [...(stateToSave.cookies || []), ...apiCookies],
            localStorage: stateToSave.localStorage || {},
            sessionStorage: (stateToSave as any).sessionStorage || {},
            fallbackDomain,
            storageOrigin: stateToSave.storageOrigin,
          };

          if (payload.isGlobal) {
            FlowWorker.globalBrowserSessions[payload.name] = hybridState;
          } else {
            this.localBrowserSessions[payload.name] = hybridState;
          }

          if (payload.persist) {
            if (this.config.protectedHandoff) throw new Error('Session persistence is disabled in a handoff run.');
            try {
              writePrivateState(process.cwd(), "sessions/" + stateSessionFile(payload.name), JSON.stringify(hybridState, null, 2));
            } catch (err: any) {
              throw new Error(`Could not securely persist session "${payload.name}": ${err.message}`);
            }
          }
        }
        break;

      case "use":
        if (payload.type === "session") {
          let loadedState = payload.isGlobal
            ? FlowWorker.globalBrowserSessions[payload.name]
            : this.localBrowserSessions[payload.name];

          if (!loadedState) {
            const fileData = readPrivateState(process.cwd(), "sessions/" + stateSessionFile(payload.name));
            if (fileData !== undefined) {
              try {
                loadedState = JSON.parse(fileData);

                if (payload.isGlobal) {
                  FlowWorker.globalBrowserSessions[payload.name] = loadedState;
                } else {
                  this.localBrowserSessions[payload.name] = loadedState;
                }
              } catch (err) {
                throw new Error(
                  `State Error: Failed to parse persisted session file for "${payload.name}".`,
                );
              }
            }
          }

          if (!loadedState)
            throw new Error(
              `State Error: The session "${payload.name}" does not exist in memory or on disk.`,
            );

          await this.web.injectStorage(
            loadedState.cookies,
            loadedState.localStorage,
            loadedState.fallbackDomain,
            loadedState.sessionStorage,
            loadedState.storageOrigin,
          );
        }
        break;

      case "open":
        await this.web.navigate(payload.url);
        break;
      case "click":
        await this.web.click(payload.selector, payload.elementType, payload.toggleIndex);
        break;
      case "hover":
        await this.web.hover(payload.selector, payload.elementType);
        break;
      case "forceClick":
        await this.web.forceClick(payload.selector, payload.elementType);
        break;
      case "type":
        await this.web.type(
          payload.selector,
          payload.text,
          payload.elementType,
        );
        break;
      case "forceType":
        await this.web.forceType(
          payload.selector,
          payload.text,
          payload.elementType,
        );
        break;
      case "passcode":
        await this.web.passcode(
          payload.selector,
          payload.text,
          payload.elementType,
        );
        break;
      case "check":
        await this.web.check(payload.selector, payload.elementType);
        break;
      case "uncheck":
        await this.web.uncheck(payload.selector, payload.elementType);
        break;
      case "upload":
        await this.web.upload(
          payload.selector,
          payload.file,
          payload.elementType,
        );
        break;
      case "set":
        await this.web.set(
          payload.selector,
          payload.value,
          payload.elementType,
        );
        break;
      case "select":
        await this.web.select(
          payload.option,
          payload.selector,
          payload.elementType,
        );
        break;
      case "drag":
        await this.web.drag(payload.source, payload.destination);
        break;
      case "switchTo":
        await this.web.switchTo(payload.target);
        await this.startStreaming();
        break;
      case "acceptDialog":
        await this.web.acceptDialog();
        break;
      case "rejectDialog":
        await this.web.rejectDialog();
        break;
      case "close":
        await this.web.close(payload.selector);
        break;
      case "injectAudio":
        await this.web.injectAudio(payload.file);
        break;
      case "waitForPipeline":
        await this.waitForPipeline();
        break;

      case "expect":
        const expectType = payload.type;

        if (
          ["status", "responseTime", "resBody", "resHeader", "cookie"].includes(
            expectType,
          )
        ) {
          const apiState = this.api.getState();

          if (expectType === "status") {
            const expectedStatus = payload.statusCode || payload.value;
            if (String(apiState.status) !== String(expectedStatus))
              throw new Error(
                `API Assertion Failed: Expected HTTP status ${expectedStatus}, but got ${apiState.status}`,
              );
          } else if (expectType === "responseTime") {
            const threshold = validateResponseTimeThreshold(payload.threshold ?? payload.value)!;
            if (apiState.responseTime > threshold)
              throw new Error(
                `API Assertion Failed: Expected response time to be less than ${threshold}ms, but got ${apiState.responseTime}ms`,
              );
          } else {
            let actualValue;
            if (expectType === "resBody")
              actualValue = this.extractFromJsonPath(
                apiState.body,
                payload.jsonPath,
              );
            else if (expectType === "resHeader")
              actualValue =
                apiState.headers?.[(payload.jsonPath || "").toLowerCase()];
            else if (expectType === "cookie") {
              const cookies = apiState.headers?.["set-cookie"];
              if (Array.isArray(cookies)) {
                const match = cookies.find((c) =>
                  c.startsWith(`${payload.jsonPath}=`),
                );
                if (match) actualValue = match.split("=")[1].split(";")[0];
              }
            }

            const assertionsArray = Array.isArray(payload.assertions)
              ? payload.assertions
              : payload.condition
                ? [{ condition: payload.condition, value: payload.value }]
                : [];

            validateApiAssertions(assertionsArray);
            for (const assertion of assertionsArray) {
              const condition = assertion.condition;
              const rawExpected = assertion.value;
              const expectedLower = String(rawExpected || "").toLowerCase();

              if (condition === "type.of" || condition === "format") {
                let isValid = false;
                const strActual = String(actualValue);

                if (expectedLower === "email")
                  isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(strActual);
                else if (expectedLower === "uuid")
                  isValid =
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                      strActual,
                    );
                else if (expectedLower === "url") {
                  try {
                    new URL(strActual);
                    isValid = true;
                  } catch {
                    isValid = false;
                  }
                } else if (expectedLower === "date")
                  isValid = !isNaN(Date.parse(strActual));
                else if (expectedLower === "hex")
                  isValid = /^#?([a-f0-9]{6}|[a-f0-9]{3})$/i.test(strActual);
                else {
                  let actualType: string = typeof actualValue;
                  if (actualValue === null) actualType = "null";
                  else if (Array.isArray(actualValue)) actualType = "array";
                  isValid = actualType === expectedLower;
                }

                if (!isValid)
                  throw new Error(
                    `API Assertion Failed: Expected "${payload.jsonPath}" to be ${expectedLower}, but got "${actualValue}"`,
                  );
              } else if (condition === "matches") {
                const regex = new RegExp(rawExpected);
                if (!regex.test(String(actualValue))) {
                  throw new Error(
                    `API Assertion Failed: Expected "${payload.jsonPath}" to match regex "${rawExpected}", but got "${String(actualValue)}"`,
                  );
                }
              } else if (["greaterthan", "lessthan"].includes(condition)) {
                const numActual = Number(actualValue);
                const numExpected = Number(rawExpected);
                if (isNaN(numActual) || isNaN(numExpected))
                  throw new Error(
                    `API Assertion Failed: Numeric comparison requires valid numbers.`,
                  );
                if (condition === "greaterthan" && !(numActual > numExpected))
                  throw new Error(
                    `API Assertion Failed: Expected ${numActual} > ${numExpected}`,
                  );
                if (condition === "lessthan" && !(numActual < numExpected))
                  throw new Error(
                    `API Assertion Failed: Expected ${numActual} < ${numExpected}`,
                  );
              } else if (condition.startsWith("length")) {
                const len =
                  Array.isArray(actualValue) || typeof actualValue === "string"
                    ? actualValue.length
                    : undefined;
                if (len === undefined)
                  throw new Error(
                    `API Assertion Failed: "${payload.jsonPath}" has no length.`,
                  );
                const numExpected = Number(rawExpected);
                if (condition === "length" && len !== numExpected)
                  throw new Error(
                    `API Assertion Failed: Expected length ${numExpected}, got ${len}`,
                  );
                if (condition === "length.greaterthan" && !(len > numExpected))
                  throw new Error(
                    `API Assertion Failed: Expected length > ${numExpected}, got ${len}`,
                  );
                if (condition === "length.lessthan" && !(len < numExpected))
                  throw new Error(
                    `API Assertion Failed: Expected length < ${numExpected}, got ${len}`,
                  );
              } else if (["includes", "does.not.include"].includes(condition)) {
                const isArrayOrString =
                  Array.isArray(actualValue) || typeof actualValue === "string";
                if (!isArrayOrString)
                  throw new Error(
                    `API Assertion Failed: Cannot check inclusion on non-collection type.`,
                  );
                const hasItem = actualValue.includes(rawExpected);
                if (condition === "includes" && !hasItem)
                  throw new Error(
                    `API Assertion Failed: Expected inclusion of "${rawExpected}"`,
                  );
                if (condition === "does.not.include" && hasItem)
                  throw new Error(
                    `API Assertion Failed: Expected exclusion of "${rawExpected}"`,
                  );
              } else if (["has.key", "does.not.have.key"].includes(condition)) {
                if (typeof actualValue !== "object" || actualValue === null)
                  throw new Error(
                    `API Assertion Failed: Key check requires object.`,
                  );
                const hasKey = rawExpected in actualValue;
                if (condition === "has.key" && !hasKey)
                  throw new Error(
                    `API Assertion Failed: Object missing key "${rawExpected}"`,
                  );
                if (condition === "does.not.have.key" && hasKey)
                  throw new Error(
                    `API Assertion Failed: Object should not contain key "${rawExpected}"`,
                  );
              } else if (["is.empty", "not.empty"].includes(condition)) {
                const isEmpty =
                  actualValue === undefined ||
                  actualValue === null ||
                  actualValue === "" ||
                  (Array.isArray(actualValue) && actualValue.length === 0) ||
                  (typeof actualValue === "object" &&
                    Object.keys(actualValue).length === 0);

                const isNegated = condition === "not.empty";
                const passed = isNegated ? !isEmpty : isEmpty;
                if (!passed)
                  throw new Error(
                    `API Assertion Failed: Expected "${payload.jsonPath}" to be ${isNegated ? "not empty" : "empty"}, but got "${actualValue}"`,
                  );
              } else {
                const isNegated = ["to.not.be", "is.not"].includes(condition);
                const isToBe = ["to.be", "is"].includes(condition);
                const knownTypes = [
                  "string",
                  "number",
                  "boolean",
                  "array",
                  "object",
                  "null",
                  "undefined",
                ];

                if (
                  ["equals", "contains"].includes(condition) ||
                  ((isToBe || isNegated) && !knownTypes.includes(expectedLower))
                ) {
                  const strActual = String(actualValue);
                  const isEquals =
                    condition === "equals" ||
                    ((isToBe || isNegated) && !knownTypes.includes(expectedLower));

                  if (isEquals) {
                    const match = strActual === rawExpected;
                    const passed = isNegated ? !match : match;
                    if (!passed)
                      throw new Error(
                        `API Assertion Failed: Expected "${payload.jsonPath}" ${isNegated ? "not to equal" : "to equal"} "${rawExpected}", but got "${strActual}"`,
                      );
                  } else if (condition === "contains") {
                    const match = strActual.includes(rawExpected);
                    if (!match)
                      throw new Error(
                        `API Assertion Failed: Expected "${strActual}" to contain "${rawExpected}"`,
                      );
                  }
                } else if (isToBe || isNegated) {
                  let checkPassed = false;
                  let actualType: string = typeof actualValue;
                  if (actualValue === null) actualType = "null";
                  else if (Array.isArray(actualValue)) actualType = "array";
                  else if (actualValue === undefined) actualType = "undefined";

                  checkPassed = isNegated
                    ? actualType !== expectedLower
                    : actualType === expectedLower;

                  if (!checkPassed) {
                    const expectedStr = isNegated
                      ? `not to be "${expectedLower}"`
                      : `to be "${expectedLower}"`;
                    throw new Error(
                      `API Assertion Failed: Expected "${payload.jsonPath}" ${expectedStr}, but got type "${actualType}".`,
                    );
                  }
                }
              }
            }
          }
        } else if (expectType === "visible")
          await this.web.expectVisible(payload.selector, payload.elementType);
        else if (expectType === "text")
          await this.web.expectText(
            payload.selector,
            payload.fuzzy,
            payload.elementType,
          );
        else if (expectType === "value")
          await this.web.expectValue(
            payload.selector,
            payload.text,
            payload.elementType,
          );
        else if (expectType === "attribute") {
          const deadline = Date.now() + this.config.timeout;
          let actual: string | null = null;
          const failure = () => `Attribute assertion failed: ${payload.attribute} on ${payload.selector}. Expected ${payload.fuzzy ? 'to contain ' : ''}${JSON.stringify(payload.text)}, received ${JSON.stringify(actual)}.`;
          while (true) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error(failure());
            try {
              actual = await withDeadline(
                this.web.getAttribute(payload.selector, payload.attribute, payload.elementType), remaining,
              );
            } catch (error) {
              throw new Error(`${failure()}\n${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
            if (actual !== null && (payload.fuzzy ? actual.includes(payload.text) : actual === payload.text)) break;
            if (Date.now() >= deadline) throw new Error(failure());
            await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(50, deadline - Date.now()))));
          }
        }
        else if (expectType === "transcript")
          await this.web.expectTranscript(payload.text);
        break;
    }
  }

  private async setupNetworkInterception() {
    const context = this.web.getPage().context();
    if (this.interceptedContexts.has(context)) return;
    this.interceptedContexts.add(context);
    context.on("response", async (response) => {
      const lockedFileName = this.currentFileName;
      const request = response.request();
      const type = request.resourceType();
      if (type !== "fetch" && type !== "xhr") return;

      let responseBody: any = null;
      try {
        const text = await response.text();
        responseBody = JSON.parse(text);
      } catch {
        responseBody = "[Body capture failed]";
      }

      let requestBody: any = null;
      let rawPostData: string | null = null;
      try {
        rawPostData = request.postData();
        if (rawPostData) requestBody = JSON.parse(rawPostData);
      } catch {
        requestBody = "[Request body capture failed]";
      }

      const sharedId = Math.random().toString(36).substr(2, 9);
      const urlObj = new URL(request.url());
      const endpointName = urlObj.pathname.split("/").pop() || urlObj.pathname;

      const requestHeaders = await request.allHeaders().catch(() => request.headers());
      const curlString = this.web.synthesizeCurl(
        request.method(),
        request.url(),
        requestHeaders,
        rawPostData,
      );

      this.emitLog(
        "REST",
        response.status() < 400 ? "success" : "error",
        `${request.method()} ${endpointName}`,
        {
          method: request.method(),
          url: request.url(),
          requestHeaders: requestHeaders,
          requestBody: requestBody,
          rawReplayRequest: { method: request.method(), url: request.url(), headers: requestHeaders, body: rawPostData },
          responseStatus: response.status(),
          responseHeaders: response.headers(),
          responseBody: responseBody,
          curlString: curlString,
        },
        sharedId,
        lockedFileName,
      );

      this.broadcast("NETWORK_REQ", {
        id: sharedId,
        method: request.method(),
        url: request.url(),
        name: endpointName,
        status: response.status(),
        curlString: curlString,
        time: new Date().toLocaleTimeString([], {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        fileName: lockedFileName,
      });
    });
  }

  private async finishFileBrowser() {
    let target: string | undefined;
    if (!this.config.protectedHandoff && this.config.recordVideo !== false) {
      const root = this.config.projectRoot || process.cwd();
      try {
        target = prepareEvidenceFile(this.config, localVideoPath(root, this.currentFileName));
      } catch {
        // A recording path problem must still allow the browser to shut down.
      }
    }

    for (const message of (this.web.pageErrors || []).filter(Boolean)) {
      this.broadcast('BROWSER_ERROR', { message, fileName: this.currentFileName });
    }
    try {
      await this.native.dispose();
      const saved = await this.web.shutdown(target);
      if (!saved || !target) return;
      protectEvidenceTree(this.config, path.dirname(target));
      if (this.config.ci === false && fs.statSync(target).size > 0) {
        this.broadcast('LOCAL_VIDEO_READY', { fileName: this.currentFileName });
      }
      if (!this.isSilent) console.log(chalk.gray('      [Video]: Recorded ' + this.currentFileName));
    } catch {
      // No replay is advertised when finalizing the recording fails.
    }
  }

  private async startStreaming() {
    clearInterval(this.fallbackStream);
    if (this.currentCdpSession) {
      const prior = this.currentCdpSession;
      this.currentCdpSession = null;
      await prior.detach().catch(() => {});
    }
    if (this.config.ci || !screenshotEvidence(this.config)) return;
    const page = this.web.getPage();
    const fileName = this.currentFileName;
    if (this.config.browser && this.config.browser !== 'chromium') {
      let busy = false;
      this.fallbackStream = setInterval(async () => {
        if (busy || page.isClosed() || !screenshotEvidence(this.config)) return;
        busy = true;
        try {
          const base64 = (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64');
          if (!page.isClosed() && screenshotEvidence(this.config)) this.broadcast('BROWSER_FRAME', { base64, fileName });
        } catch {
        } finally {
          busy = false;
        }
      }, 250);
      this.fallbackStream.unref();
      return;
    }

    const session = await page.context().newCDPSession(page);
    this.currentCdpSession = session;
    await session.send('Page.startScreencast', { format: 'jpeg', quality: 60 });
    session.on('Page.screencastFrame', ({ data, sessionId }: any) => {
      if (this.currentCdpSession === session && screenshotEvidence(this.config)) {
        this.broadcast('BROWSER_FRAME', { base64: data, fileName });
      }
      session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
  }

  public async shutdown(): Promise<void> {
    clearInterval(this.fallbackStream);
    await this.pendingFixtureSetup?.catch(() => {});
    await this.finishScenarioCleanup();
    await this.finishHandoffCleanup();
    await this.finishWorkerFixtures();
    await this.native.dispose();
    try {
      await this.web.shutdown();
    } catch (e) {}
  }
}
