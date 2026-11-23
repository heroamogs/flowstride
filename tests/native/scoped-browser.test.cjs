const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Parser } = require('../../dist/parser/parser');
const { Lexer } = require('../../dist/parser/lexer');
const { workspace, launch } = require('./practice-fixtures.cjs');

const examples = path.resolve(__dirname, '../../examples/native-workflows');
const sources = path.join(examples, 'scoped-browser');
const parse = text => new Parser(new Lexer(text).tokenise()).parseFragment();

test('scoped grammar distinguishes literals, JSON payloads, indexes and deadlines', () => {
  const read = command => parse(command)[0].payload;
  assert.deepEqual(read('flow.find "timeout: 3000";').target, {tag:'text', text:'timeout: 3000'});
  assert.equal(read('flow.find article[0] inside main "timeout: 3000";').timeout, 3000);
  assert.equal(read('flow.expect tr equals length.0;').value, 0);
  assert.equal(read('flow.expect attribute current "href" contains "/booking/";').condition, 'attributeContains');
  assert.equal(read('flow.expect attribute "#booking" "href" contains "/booking/";').fuzzy, true);
  assert.equal(read('flow.expect text "this string contains absent and equals length.0";').type, 'text');
  assert.equal(read('flow.find "row" inside table[0];').target.inside.index, 0);
  assert.equal(read('flow.expect visible "Ready";').type, 'visible');
  assert.equal(read('flow.assert.that {"selector":"tr","condition":"count","value":4};').pluginMethod, 'assert.that');
  assert.equal(parse('flow.within { flow.each tr { flow.expect text td[2] contains "@"; }; };').length, 5);
  for (const command of ['flow.find tr[-1];', 'flow.each tr by cell "Email" {', 'flow.within { flow.open "/"; };',
      'flow.find tr "timeout: 0";','flow.expect tr equals length.-1;', 'flow.ascend current;', '};']) {
    assert.throws(() => parse(command), /[Ll]ine/);
  }
});

test('CLI keeps scopes, iteration identities, assertion evidence and exit codes', {timeout:180000}, async t => {
  const project = workspace(t);
  const {startExampleApp} = await import(pathToFileURL(path.join(examples,'shared/server.mjs')).href);
  const app = await startExampleApp({port:0});
  t.after(() => app.close());
  fs.cpSync(sources,path.join(project.dir,'examples'),{recursive:true});
  fs.writeFileSync(path.join(project.dir,'flowstride.config.json'), JSON.stringify({
    headless:true, recordVideo:false, cloudSync:false, timeout:3000
  }));
  async function run(file, expectedCode) {
    const result = await launch(t, project, ['run', file, '--ci', '--workers','1', '--browser', process.env.FS_SCOPED_TEST_BROWSER || 'chromium'],
      {BASE_URL:app.url}, 65000).finished;
    const report = project.summary();
    assert.equal(result.code, expectedCode, JSON.stringify({errors:report.errors, failures:report.steps.filter(step => step.status === "failed")}, null, 2));
    return report;
  }
  await run('examples/flows', 0);
  const failed = await run('examples/negative/fourth-email.flow', 1);
  const evidence = JSON.stringify(failed.steps.filter(step=>step.status === 'failed'));
  for (const detail of ['row 4 of 4', 'Email', 'tim.example.com']) assert.ok(evidence.includes(detail), evidence);
  const queue = fs.readFileSync(path.join(sources,'flows/approve-original-users.flow'),'utf8');
  fs.writeFileSync(path.join(project.dir,'queue-by-email.flow'), queue.replace('by attribute "data-user-id"', 'by cell "Email"'));
  await run('queue-by-email.flow', 0);
  for (const [mode, message] of [['empty','at least one'], ['duplicate','unique key']]) {
    fs.writeFileSync(path.join(project.dir,'queue.flow'), queue.replace('/scoped-customers','/scoped-customers?case=' + mode).replace('timeout: 3000','timeout: 300'));
    const result = await run('queue.flow',1);
    assert.ok(JSON.stringify(result.steps).includes(message), JSON.stringify(result.errors));
  }
});
test('live dashboard renders the actual fourth-row failure', { timeout: 90000 }, async t => {
  const project = workspace(t);
  const {chromium} = require('playwright');
  const {captureDashboardLaunch, writeConfig} = require('./practice-fixtures.cjs');
  const {startExampleApp} = await import(pathToFileURL(path.join(examples,'shared/server.mjs')).href);
  const app = await startExampleApp({port:0});
  t.after(() => app.close());
  const file = 'fourth-email.flow';
  fs.copyFileSync(path.join(sources,'negative',file), path.join(project.dir,file));
  writeConfig(project.dir, {headless:true,recordVideo:false,cloudSync:false,timeout:3000});
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const invocation = launch(t, project, ['run',file], {...captureDashboardLaunch(project), BASE_URL:app.url}, 80000);
    const dashboard = await invocation.outputMatch(/\[Test dashboard\] (http:\/\/localhost:\d+)/);
    await page.goto(dashboard);
    const flow = page.locator('[data-flow-result="fourth-email.flow"][data-flow-status="failed"]');
    await flow.waitFor({ timeout: 50000 });
    const step = flow.locator('[data-step-status="failed"]');
    if (await step.count() === 0) await flow.getByText(file, {exact:true}).click();
    await step.waitFor({ timeout: 5000 });
    const details = await step.innerText();
    for (const expected of ['row 4 of 4','Email','Expected:', '@','Actual:', 'tim.example.com']) {
      assert.ok(details.includes(expected),details);
    }
    await page.close();
    await invocation.finished;
  } finally {
    await browser.close();
  }
});
test('a retry keeps the failed row in history and counts only the new rows in the final result', async t => {
  const project = workspace(t);
  const http = require('node:http');
  let visits = 0;
  const server = http.createServer((req,res) => {
    if (req.url !== '/records') return res.writeHead(404).end();
    const names = ++visits === 1 ? ['Ada','Bayo','Missing'] : ['Ada','Bayo'];
    const rows = names.map(name => '<tr><td>' + name + '</td><td>' +
      (name === 'Missing' ? 'invalid' : 'valid') + '</td></tr>').join('');
    res.writeHead(200, {'Content-Type':'text/html'}).end('<table><tbody>' + rows + '</tbody></table>');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  fs.writeFileSync(path.join(project.dir,'flowstride.config.json'),JSON.stringify({
    headless:true, recordVideo:false, cloudSync:false, timeout:2000, retries:1
  }));
  fs.writeFileSync(path.join(project.dir,'retry.flow'), [
    'Feature: Retry a changing customer table', 'Scenario: Check each name and status',
    'Given "The customer records are open"', 'flow.open "/records";',
    'When "I select the records"', 'flow.find tbody;',
    'Then "Every status is valid"', 'flow.within {', 'flow.each tr {',
    'flow.expect text td[1] equals "valid" "timeout: 200";', 'flow.expect text td[0] not.empty;', '};', '};'
  ].join('\n'));
  const result = await launch(t,project,['run','retry.flow','--ci'],{
    BASE_URL:'http://127.0.0.1:' + server.address().port
  }).finished;
  const report = project.summary();
  assert.equal(result.code,0,JSON.stringify({errors:report.errors,metrics:report.metrics}));
  assert.equal(visits,2);
  assert.deepEqual(report.attempts.map(attempt => attempt.status),['failed','passed']);
  assert.ok(JSON.stringify(report.attempts[0].steps).includes('row 3 of 3'));
  assert.equal(report.steps.some(step => step.id.endsWith('_row3')),false);
  assert.equal(report.metrics.incomplete,0);

  visits = 0;
  const {captureDashboardLaunch} = require('./practice-fixtures.cjs');
  const browser = await require('playwright').chromium.launch();
  try {
    const page = await browser.newPage();
    const live = launch(t,project,['run','retry.flow'],{
      ...captureDashboardLaunch(project), BASE_URL:'http://127.0.0.1:' + server.address().port
    },60000);
    const dashboard = await live.outputMatch(/\[Test dashboard\] (http:\/\/localhost:\d+)/);
    await page.goto(dashboard);
    const flow = page.locator('[data-flow-result="retry.flow"][data-flow-status="passed"]');
    await flow.waitFor({timeout:40000});
    if (!await flow.locator('[data-step-id]').count()) await flow.getByText('retry.flow',{exact:true}).click();
    const historical = flow.locator('[data-step-status="failed"]').filter({hasText:'Attempt 1 only'});
    await historical.waitFor();
    assert.match(await historical.innerText(),/row 3 of 3/);
    await page.close();
    await live.finished;
  } finally {
    await browser.close();
  }
});
