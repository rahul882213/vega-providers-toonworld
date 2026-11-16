const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {minify} = require('terser');
const {createProviderHeader} = require('../provider-build-metadata');

test('stamps the exact manifest ID and version without changing module exports', async () => {
  const entry = {value: 'toonworld4all', version: '1.4'};
  const code = '"use strict"; exports.getStream = function () { return "working"; };';
  for (const payload of [code, (await minify(code)).code]) {
    const result = createProviderHeader(entry) + payload;
    assert.ok(result.startsWith('// @vega-provider toonworld4all\n// @vega-version 1.4\n'));
    const context = {exports: {}};
    vm.runInNewContext(result, context);
    assert.equal(context.exports.getStream(), 'working');
  }
});
test('rejects missing metadata or injected newlines', () => {
  for (const entry of [undefined, {value:'toonworld4all'}, {value:'toonworld4all',version:'1.4\ncode()'}, {value:'toonworld4all\ncode()',version:'1.4'}]) {
    assert.throws(() => createProviderHeader(entry), /manifest/);
  }
});
