const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Lexer } = require('../../dist/parser/lexer');
const { Parser } = require('../../dist/parser/parser');
const manifest = require('../../dist/parser/language-manifest.json');

test('the shipped editor manifest describes parseable commands and soft assertions', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest, require('../../src/parser/language-manifest.json'));
  const parse = command => new Parser(new Lexer(command).tokenise()).parseFragment()[0];
  for (const [name, example] of Object.entries(manifest.commands)) {
    const step = parse('flow.' + name + ' ' + JSON.stringify(example) + ';');
    assert.equal(step.action, 'native', name);
    assert.equal(step.payload.pluginMethod, name);
    assert.deepEqual(step.payload.data, example);
  }
  for (const name of manifest.assertions) {
    assert(Object.hasOwn(manifest.commands, name), name);
    assert.equal(parse('flow.soft ' + name + ' {};').payload.soft, true, name);
  }
  assert(manifest.passwordToggle);
  assert.equal(parse('flow.click passToggle[0] for "Password";').payload.toggleIndex, 0);
  assert(manifest.conditions.includes('masked') && manifest.conditions.includes('revealed'));
});
