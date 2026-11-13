import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { compileScript, parse } from 'vue/compiler-sfc';

// Exercise the actual dialog handlers, not a copied implementation. Only refs,
// HTTP and notifications are supplied by the harness; no browser or real API.
const source = readFileSync(new URL('../src/views/sys-setting/index.vue', import.meta.url), 'utf8');
const { descriptor } = parse(source);
const { scriptSetupAst } = compileScript(descriptor, { id: 'send-chain-test' });
const handlers = ['openSendChain', 'moveChain'].map(name => {
  const node = scriptSetupAst.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.ok(node, `Production handler ${name} exists`);
  return descriptor.scriptSetup.content.slice(node.start, node.end);
}).join('\n');
const original = ['resend', 'sendpulse', 'qq', 'cf'];
const plain = value => JSON.parse(JSON.stringify(value));
function harness(save = async () => {}) {
  const state = {
    setting: { value: { sendChain: [...original], title: 'unchanged' } },
    settingReady: { value: true },
    settingLoading: { value: false },
    sendChainList: { value: [] },
    sendChainShow: { value: false },
    defaultSendChain: [...original],
    requests: [],
    messages: [],
    t: key => key
  };
  state.settingSet = payload => { state.requests.push(plain(payload)); return save(payload); };
  state.ElMessage = message => state.messages.push(message);
  const actions = runInNewContext(`${handlers}\n;({openSendChain, moveChain});`, state);
  return { ...state, ...actions };
}

test('saved order survives close and reopen, and later settings payloads use it', async () => {
  const h = harness();
  h.openSendChain();
  await h.moveChain(0, 1);
  const expected = ['sendpulse', 'resend', 'qq', 'cf'];
  assert.deepEqual(h.requests, [{ sendChain: expected }]);
  assert.deepEqual(plain(h.setting.value.sendChain), expected);
  h.sendChainShow.value = false;
  h.openSendChain();
  assert.deepEqual(plain(h.sendChainList.value), expected);
  assert.notEqual(h.sendChainList.value, h.setting.value.sendChain, 'dialog uses its own array');
  assert.equal(h.setting.value.title, 'unchanged');
  assert.equal(h.messages.length, 1);
  assert.equal(h.settingLoading.value, false);
});

test('failed save rolls back the dialog without changing committed settings', async () => {
  const h = harness(async () => { throw new Error('network error'); });
  h.openSendChain();
  await h.moveChain(0, 1);
  assert.deepEqual(plain(h.sendChainList.value), original);
  assert.deepEqual(plain(h.setting.value.sendChain), original);
  assert.equal(h.settingLoading.value, false);
  assert.equal(h.messages.length, 0, 'no success notification on failure');
  h.openSendChain();
  assert.deepEqual(plain(h.sendChainList.value), original);
});

test('pending save blocks more moves and reopening rather than silently dropping requests', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  h.openSendChain();
  const pending = h.moveChain(0, 1);
  assert.equal(h.settingLoading.value, true);
  const displayed = plain(h.sendChainList.value);
  await h.moveChain(1, 1);
  h.sendChainShow.value = false;
  h.openSendChain();
  assert.equal(h.sendChainShow.value, false);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(plain(h.sendChainList.value), displayed);
  finish();
  await pending;
  h.openSendChain();
  assert.deepEqual(plain(h.sendChainList.value), displayed);
});

test('moves work in both directions and stop at boundaries', async () => {
  const h = harness();
  h.openSendChain();
  await h.moveChain(0, -1);
  await h.moveChain(3, 1);
  assert.equal(h.requests.length, 0);
  await h.moveChain(2, -1);
  assert.deepEqual(plain(h.setting.value.sendChain), ['resend', 'qq', 'sendpulse', 'cf']);
  await h.moveChain(1, 1);
  assert.deepEqual(plain(h.setting.value.sendChain), original);
});

test('unloaded settings cannot be reordered and arrows are disabled during saves', async () => {
  const h = harness();
  h.openSendChain();
  h.settingReady.value = false;
  await h.moveChain(0, 1);
  assert.equal(h.requests.length, 0);
  const moveButtons = source.match(/<el-button[^>]+@click="moveChain\([^\n]+/g);
  assert.equal(moveButtons.length, 2);
  for (const button of moveButtons) assert.match(button, /:disabled="!settingReady \|\| settingLoading \|\|/);
});
