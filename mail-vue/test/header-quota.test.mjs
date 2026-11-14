import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as Vue from 'vue';
import { renderToString } from 'vue/server-renderer';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';

// Compile the production quota markup and visibility expression. No DOM,
// network, mailbox credentials, or copied visibility implementation is used.
const filename = new URL('../src/layout/header/index.vue', import.meta.url);
const { descriptor } = parse(readFileSync(filename, 'utf8'));
const { scriptSetupAst } = compileScript(descriptor, { id: 'header-quota-test' });
const declaration = scriptSetupAst.find(node => node.type === 'VariableDeclaration'
  && node.declarations.some(d => d.id.name === 'showAccountQuota'));
assert.ok(declaration, 'Header defines the quota visibility condition');
const visibility = descriptor.scriptSetup.content.slice(declaration.start, declaration.end);
function findQuota(node) {
  if (node.props?.some(prop => prop.name === 'class' && prop.value?.content === 'action-info')) return node;
  for (const child of node.children || []) {
    const found = findQuota(child);
    if (found) return found;
  }
}
const quota = findQuota(descriptor.template.ast);
assert.ok(quota, 'Production quota section exists');
const compiled = compileTemplate({ source: quota.loc.source, filename: 'quota.vue', id: 'quota-test' });
assert.deepEqual(compiled.errors, []);
const renderCode = compiled.code
  .replace(/import \{([^}]+)\} from "vue"/g, (_, bindings) => `const {${bindings.replace(/\bas\b/g, ':')}} = Vue`)
  .replace('export function render', 'function render');
const render = runInNewContext(`${renderCode}\n;render`, { Vue });
async function markup(settings, count = 3, allowed = true) {
  const showAccountQuota = runInNewContext(`${visibility}\n;showAccountQuota`, {
    computed: Vue.computed, settingStore: { settings }
  });
  const app = Vue.createSSRApp({
    setup: () => ({ showAccountQuota, accountCount: count, sendCount: '0/100', sendType: 'DAILY', hasPerm: () => allowed }),
    render
  });
  app.config.globalProperties.$t = (key, args) => args ? `${key}:${args.msg}` : key;
  app.component('el-tag', { setup: (_, { slots }) => () => Vue.h('span', slots.default?.()) });
  return renderToString(app);
}

for (const settings of [
  { manyEmail: 0, addEmail: 1 },
  { manyEmail: 1, addEmail: 0 },
  { manyEmail: 1, addEmail: 1 },
  {}
]) {
  test(`hide both quota label and value when disabled or unloaded: ${JSON.stringify(settings)}`, async () => {
    const html = await markup(settings);
    assert.doesNotMatch(html, /accountCount|totalUserAccount|unlimited|disabled|unauthorized/);
    assert.match(html, /sendCount/);
    assert.match(html, /0\/100/);
  });
}
test('enabled feature retains the account allowance', async () => {
  const html = await markup({ manyEmail: 0, addEmail: 0 });
  assert.match(html, /accountCount/);
  assert.match(html, /totalUserAccount:3/);
});
test('enabled feature retains unlimited and missing-permission states', async () => {
  assert.match(await markup({ manyEmail: 0, addEmail: 0 }, 0), /unlimited/);
  assert.match(await markup({ manyEmail: 0, addEmail: 0 }, 3, false), /unauthorized/);
});
