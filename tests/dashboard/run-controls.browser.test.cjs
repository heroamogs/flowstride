const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const parallel = require(path.join(root, 'package.json')).name === '@flowstride/pro';

// Run the actual engine in a child so the tests can send a real terminal interrupt.
async function runEngine() {
  const { FlowWorker } = require(path.join(root, 'dist/runner/flow_worker'));
  const { FlowOrchestrator } = require(path.join(root, 'dist/runner/flow_orchestrator'));
  const { WebAdapter } = require(path.join(root, 'dist/adapters/web/playwright'));
  const { ApiAdapter } = require(path.join(root, 'dist/adapters/api/undici'));
  const config = { ci: false, headless: true, browser: 'chromium', timeout: 4000, recordVideo: false,
    projectRoot: process.cwd(), onRunEvent: ({type, payload}) => {
      if (['RUN_START','RUN_COMPLETE','SUITE_START','EXECUTION_PAUSED','EXECUTION_RESUMED','FILE_FAILED'].includes(type)) process.send({ type, payload });
    }
  };
  const worker = new FlowWorker(config, new WebAdapter(config), new ApiAdapter(config), {}, {});
  const engine = new FlowOrchestrator(worker, parallel ? 2 : 1, config);
  engine.dashboardBrowser.open = async url => process.send({ type: 'URL', url });
  await engine.start(path.join(process.cwd(), 'flows'));
}

if (process.argv[2] === '--engine') {
  runEngine().catch(error => { console.error(error); process.exit(1); });
} else {
  test('dashboard pauses the real runner, targets saved flows and handles terminal shutdown', { timeout: 120000 }, async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-dashboard-controls-')));
    let serveReview;
    const reviewRequested = new Promise(resolve => { serveReview = resolve; });
    let releaseReview;
    const gate = new Promise(resolve => { releaseReview = resolve; });
    const site = http.createServer(async (req, res) => {
      if (req.url === '/review') { serveReview(); await gate; }
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body style="margin:0"><button aria-label="Review order" style="width:100vw;height:100vh" onclick="this.textContent=\'Reviewed\'">Review order</button></body></html>');
    });
    let browser, child;
    const events = [];
    let output = '';
    const wait = async (predicate, label) => {
      const deadline = Date.now() + 25000;
      while (!predicate()) {
        if (child?.exitCode != null || Date.now() > deadline) throw Error(label + '\n' + output.slice(-2500));
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    try {
      await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
      const url = 'http://127.0.0.1:' + site.address().port;
      const flows = path.join(dir, 'flows');
      fs.mkdirSync(path.join(flows, 'nested'), {recursive:true});
      const second = path.join(flows, 'nested', 'b.flow');
      const simple = name => 'Feature: Saved changes\nScenario: ' + name + '\nGiven "Open page"\n  flow.open "' + url + '";\nWhen "Observe"\n  flow.log "Checking page";\nThen "Shows review"\n  flow.expect visible "Review order";\n';
      fs.writeFileSync(second, simple('Before edit'));
      fs.writeFileSync(path.join(flows, 'a.flow'), 'Feature: Review\nScenario: Interactive review\nGiven "Open page"\n  flow.open "' + url + '/review";\nWhen "Review window"\n  flow.log "Review continued";\nThen "Check review"\n  flow.expect visible "Reviewed";\n');
      const env = {...process.env};
      for (const name of ['CI','GITHUB_ACTIONS','GITLAB_CI','CIRCLECI','JENKINS_URL','FLOWSTRIDE_NATIVE_CI','FLOWSTRIDE_API_KEY','NODE_TEST_CONTEXT']) delete env[name];
      browser = await chromium.launch({headless:true});
      const context = await browser.newContext({viewport:{width:1280,height:900}});
      child = fork(__filename, ['--engine'], {cwd:dir,env,silent:true});
      child.on('message', event => events.push(event));
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      await wait(() => events.some(e => e.type === 'URL'), 'dashboard URL');
      const launch = events.find(e => e.type === 'URL').url;
      const unrelated = await context.newPage();
      await unrelated.goto(url);
      const opened = context.waitForEvent('page');
      await unrelated.evaluate(url => window.open(url, '_blank') && true, launch);
      const dash = await opened;
      await dash.getByRole('tab', {name:'a.flow',exact:true}).click();
      await reviewRequested;
      await dash.getByRole('button',{name:'Pause and inspect'}).click();
      await dash.getByRole('button',{name:'Pausing…'}).waitFor();
      releaseReview();
      await wait(() => events.some(e => e.type === 'EXECUTION_PAUSED'), 'worker did not pause');
      const image = dash.getByAltText('Interactive paused page');
      await image.waitFor();
      assert.match(output, /Paused/);
      assert.doesNotMatch(output, /Review continued/);
      assert.equal(events.some(e => e.type === 'RUN_COMPLETE'), false);
      await dash.getByRole('button',{name:'Inspect element'}).click();
      await image.click();
      await dash.getByText(/aria-label="Review order"/).waitFor();
      await dash.getByRole('button',{name:'Finish inspecting'}).click();
      await image.click();
      await dash.getByRole('button',{name:'Resume a.flow'}).click();
      const completed = () => events.filter(e => e.type === 'RUN_COMPLETE');
      await wait(() => completed().length === 1, 'initial group');
      assert.equal(completed()[0].payload.status,'success',output);
      fs.writeFileSync(second,simple('After edit'));
      fs.writeFileSync(path.join(flows,'new.flow'),simple('Added later'));
      const runsSince = i => events.slice(i).filter(e => e.type === 'RUN_START').map(e => e.payload.scenarioName).sort();
      let mark = events.length;
      await dash.getByRole('tab',{name:'nested/b.flow',exact:true}).click();
      await dash.getByRole('button',{name:'Run',exact:true}).click();
      await wait(() => completed().length === 2, 'single selected flow');
      assert.deepEqual(runsSince(mark),['After edit']);
      fs.writeFileSync(path.join(flows,'a.flow'),simple('Original first'));
      mark = events.length;
      await dash.getByRole('button',{name:'Rerun',exact:true}).click();
      await wait(() => completed().length === 3, 'original suite rerun');
      assert.deepEqual(runsSince(mark),['After edit','Original first']);
      assert.equal(completed()[2].payload.status,'success',output);
      const manual = await context.newPage();
      await manual.goto(launch.split('#')[0]);
      await manual.getByText(/Core memory ready/).waitFor();
      const closed = dash.waitForEvent('close');
      const exit = once(child,'exit');
      child.kill('SIGINT');
      await closed;
      await manual.getByText('Flowstride has stopped. You can close this tab.').waitFor();
      assert.equal(unrelated.isClosed(),false);
      assert.equal((await exit)[0],0);
    } finally {
      releaseReview();
      if (child && child.exitCode == null && !child.signalCode) child.kill('SIGKILL');
      await browser?.close();
      site.closeAllConnections();
      await new Promise(resolve => site.close(resolve));
      fs.rmSync(dir,{recursive:true,force:true});
    }
  });

  test('Ctrl+C while paused stops the worker and leaves a usable message when Chrome refuses to close', {timeout:45000}, async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fs-dashboard-interrupt-')));
    let child, browser;
    try {
      const flows = path.join(dir,'flows');
      fs.mkdirSync(flows);
      fs.writeFileSync(path.join(flows,'stop.flow'), 'Feature: Interrupt\nScenario: Quit a pause\nGiven "Start"\n  flow.log "Ready";\nWhen "Wait here"\n  flow.pause "Review this step";\nThen "After resume"\n  flow.log "Reached end";\n');
      const env = {...process.env};
      for (const key of ['CI','GITHUB_ACTIONS','GITLAB_CI','CIRCLECI','JENKINS_URL','FLOWSTRIDE_NATIVE_CI','FLOWSTRIDE_API_KEY','NODE_TEST_CONTEXT']) delete env[key];
      browser = await chromium.launch({headless:true});
      const page = await browser.newPage();
      // Browser policies differ. Exercise the denied-close branch deterministically.
      await page.addInitScript(() => { window.close = () => { document.documentElement.dataset.closeRequested = 'yes'; }; });
      child = fork(__filename,['--engine'],{cwd:dir,env,silent:true});
      child.stdout.resume(); child.stderr.resume();
      const messages = [];
      const launch = new Promise(resolve => child.on('message', event => { messages.push(event); if (event.type === 'URL') resolve(event.url); }));
      await page.goto(await launch);
      await page.getByRole('button',{name:'Resume stop.flow'}).waitFor();
      const exit = once(child,'exit');
      child.kill('SIGINT');
      await page.getByText('Flowstride has stopped. You can close this tab.').waitFor();
      assert.equal(await page.locator('html').getAttribute('data-close-requested'),'yes');
      assert.equal((await exit)[0],130);
      assert.equal(messages.some(event => event.type === 'RUN_COMPLETE' && event.payload.status === 'success'),false);
    } finally {
      if (child && child.exitCode == null && !child.signalCode) child.kill('SIGKILL');
      await browser?.close();
      fs.rmSync(dir,{recursive:true,force:true});
    }
  });

}
