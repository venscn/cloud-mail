import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as Vue from 'vue';
import { renderToString } from 'vue/server-renderer';
import { compileTemplate, parse } from 'vue/compiler-sfc';

const { descriptor } = parse(readFileSync(new URL('../src/views/setting/index.vue', import.meta.url), 'utf8'));
function findNotice(node) {
  if (node.tag === 'div' && node.children?.some(child => child.children?.some(text => text.type === 5 && text.content.content.includes("$t('noticeTitle')")))) return node;
  for (const child of node.children || []) {
    const found = findNotice(child);
    if (found) return found;
  }
}
const section = findNotice(descriptor.template.ast);
assert.ok(section, 'Production system notice section exists');
const { code, errors } = compileTemplate({ source: section.loc.source, filename: 'notice.vue', id: 'notice-test' });
assert.deepEqual(errors, []);
const renderCode = code
  .replace(/import \{([^}]+)\} from "vue"/g, (_, bindings) => `const {${bindings.replace(/\bas\b/g, ':')}} = Vue`)
  .replace('export function render', 'function render');
const render = runInNewContext(`${renderCode}\n;render`, { Vue });
async function markup(settings) {
  const app = Vue.createSSRApp({
    setup: () => ({ settingStore: { settings }, uiStore: { showNotice() {} } }),
    render
  });
  app.config.globalProperties.$t = key => key;
  app.component('el-button', { setup: (_, { slots }) => () => Vue.h('button', slots.default?.()) });
  return renderToString(app);
}
for (const settings of [{ notice: 1 }, {}]) {
  test(`hidden notice removes the whole personal settings section: ${JSON.stringify(settings)}`, async () => {
    const html = await markup(settings);
    assert.doesNotMatch(html, /noticeTitle|noticeInfo|viewNotice|button|preference-item/);
  });
}
test('enabled notice keeps its title, description and view action', async () => {
  const html = await markup({ notice: 0 });
  for (const text of ['noticeTitle', 'noticeInfo', 'viewNotice', 'button', 'preference-item']) assert.ok(html.includes(text));
});
