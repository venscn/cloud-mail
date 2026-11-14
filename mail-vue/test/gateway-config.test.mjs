import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import * as Vue from 'vue'
import {renderToString} from 'vue/server-renderer'
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc'
import {gatewayDisplayConfig, gatewaySettingsPatch, normalizeGatewayHostname} from '../src/components/gateway-settings/gateway-config.js'
import {useGatewayAdminSettings} from '../src/components/gateway-admin-settings/use-gateway-admin-settings.js'
import zh from '../src/i18n/gateway-zh.js'
import en from '../src/i18n/gateway-en.js'

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8')
const personal = read('../src/views/setting/index.vue')
const admin = read('../src/components/gateway-admin-settings/index.vue')
const client = read('../src/components/gateway-settings/index.vue')
const split = {gatewayEnabled: 1, gatewayImapHostname: 'imap.example.invalid', gatewaySmtpHostname: 'smtp.example.invalid'}
const hidden = {enabled: false, imapHostname: '', smtpHostname: ''}
function find(node, predicate) {
    if (predicate(node)) return node
    for (const child of node.children || []) {
        const match = find(child, predicate)
        if (match) return match
    }
}
function renderTemplate(source) {
    const {code, errors} = compileTemplate({source, filename: 'gateway-config.vue', id: 'gateway-config-test'})
    assert.deepEqual(errors, [])
    const executable = code.replace(/import \{([^}]+)\} from "vue"/g, (_, bindings) => `const {${bindings.replace(/\bas\b/g, ':')}} = Vue`)
        .replace('export function render', 'function render')
    return runInNewContext(`${executable}\n;render`, {Vue})
}

test('public display fails closed unless enabled with two valid hostnames', () => {
    for (const settings of [undefined, {}, {...split, gatewayEnabled: 0}, {...split, gatewayEnabled: '1'},
        {...split, gatewayEnabled: true}, {gatewayEnabled: 1}, {...split, gatewaySmtpHostname: 'https://smtp.example.invalid'}]) {
        assert.deepEqual(gatewayDisplayConfig(settings), hidden)
    }
    assert.deepEqual(gatewayDisplayConfig({...split, gatewayImapHostname: ' IMAP.Example.Invalid '}),
        {enabled: true, imapHostname: 'imap.example.invalid', smtpHostname: 'smtp.example.invalid'})
})

test('old shared settings are ignored; missing or null endpoints require fresh configuration', () => {
    for (const fields of [{}, {gatewayImapHostname: null, gatewaySmtpHostname: null}]) {
        assert.deepEqual(gatewayDisplayConfig({gatewayEnabled: 1, gatewayHostname: 'legacy.example.invalid', ...fields}), hidden)
    }
    assert.deepEqual(gatewayDisplayConfig({...split, gatewayHostname: 'legacy.example.invalid', gatewayImapHostname: null}), hidden)
    assert.deepEqual(gatewayDisplayConfig({...split, gatewayHostname: 'ignored.example.invalid'}),
        {enabled: true, imapHostname: split.gatewayImapHostname, smtpHostname: split.gatewaySmtpHostname})
})

test('explicit empty or invalid split hostnames never fall back to a valid legacy hostname', () => {
    for (const field of ['gatewayImapHostname', 'gatewaySmtpHostname']) {
        for (const value of ['', 'https://wrong.example.invalid', false, 993]) {
            assert.deepEqual(gatewayDisplayConfig({...split, gatewayHostname: 'legacy.example.invalid', [field]: value}), hidden)
        }
    }
})

test('hostname validation rejects schemes, ports, paths, IPs, controls and invalid DNS labels on either side', () => {
    for (const value of ['https://imap.example.invalid', 'imap.example.invalid:993', 'imap.example.invalid/a', 'a@b.example',
        '127.0.0.1', '[::1]', 'localhost', '-a.example', 'a-.example', 'a..example', 'a_.example', 'a.example.', 'example.123',
        '\nimap.example.invalid', 'imap.example.invalid\r', '<img src=x>.example', '邮箱.example', 'a'.repeat(64)+'.example']) {
        assert.equal(normalizeGatewayHostname(value), null, JSON.stringify(value))
        assert.equal(gatewaySettingsPatch(1, value, split.gatewaySmtpHostname), null)
        assert.equal(gatewaySettingsPatch(1, split.gatewayImapHostname, value), null)
    }
    assert.equal(gatewaySettingsPatch(1, '', split.gatewaySmtpHostname), null)
    assert.equal(gatewaySettingsPatch(1, split.gatewayImapHostname, ''), null)
    assert.equal(gatewaySettingsPatch('1', split.gatewayImapHostname, split.gatewaySmtpHostname), null)
    assert.deepEqual(gatewaySettingsPatch(0, '', ''), {gatewayEnabled: 0, gatewayImapHostname: '', gatewaySmtpHostname: ''})
})

test('production personal-settings v-if does not mount management when disabled or either hostname is invalid', async () => {
    const {descriptor} = parse(personal)
    const gateway = find(descriptor.template.ast, node => node.tag === 'GatewaySettings')
    assert.ok(gateway)
    const render = renderTemplate(gateway.loc.source)
    for (const settings of [{}, {...split, gatewayEnabled: 0}, {...split, gatewaySmtpHostname: ''}, split]) {
        let mounted = 0
        const app = Vue.createSSRApp({setup: () => ({gatewayConfig: gatewayDisplayConfig(settings)}), render})
        app.component('GatewaySettings', {setup() {mounted++; return () => Vue.h('section', 'client settings')}})
        const html = await renderToString(app)
        const expected = settings === split
        assert.equal(mounted, expected ? 1 : 0)
        assert.equal(html.includes('client settings'), expected)
    }
})

test('production client markup renders separate incoming and outgoing hostnames and localized iOS instructions', async () => {
    const {descriptor} = parse(client)
    const rows = ['gateway-imap-hostname', 'gateway-smtp-hostname'].map(id => find(descriptor.template.ast,
        node => node.tag === 'dd' && node.loc.source.includes(`data-testid="${id}"`)))
    const ios = find(descriptor.template.ast, node => node.tag === 'li' && node.loc.source.includes('gatewayIosStep2'))
    assert.ok(rows.every(Boolean) && ios)
    const render = renderTemplate(`<div>${rows.map(row => row.loc.source).join('')}${ios.loc.source}</div>`)
    for (const labels of [zh, en]) {
        const app = Vue.createSSRApp({setup: () => ({gatewayConfig: gatewayDisplayConfig(split)}), render})
        app.config.globalProperties.$t = (key, values = {}) => labels[key].replace(/\{(\w+)\}/g, (_, name) => values[name])
        const html = await renderToString(app)
        assert.match(html, /gateway-imap-hostname">imap\.example\.invalid<\/code>/)
        assert.match(html, /gateway-smtp-hostname">smtp\.example\.invalid<\/code>/)
        assert.equal((html.match(/imap\.example\.invalid/g) || []).length, 1)
        assert.equal((html.match(/smtp\.example\.invalid/g) || []).length, 1)
        assert.ok(html.includes(labels.gatewayIosStep2))
        assert.doesNotMatch(html, /undefined|\{(?:imap|smtp)?[Hh]ostname\}/)
    }
    assert.doesNotMatch(client, /gatewayDeploymentRequired|gatewayServerHint|window\.location|gatewayConfig\.hostname/)
    assert.match(admin, /gatewayDeploymentRequired/)
    assert.match(admin, /v-model="imapHostname"/)
    assert.match(admin, /v-model="smtpHostname"/)
})

test('gateway placement remains after Other/notice and immediately before deletion', () => {
    const gateway = personal.indexOf('<GatewaySettings')
    assert.ok(gateway > personal.indexOf("$t('noticeTitle')"))
    assert.ok(gateway < personal.indexOf('<div class="del-email"'))
    assert.match(personal.slice(gateway, personal.indexOf('<div class="del-email"')), /^<GatewaySettings[^>]+\/>\s*$/)
    assert.match(personal, /gatewayDisplayConfig\(settingStore\.settings\)/)
})

test('admin saves independent hostnames without resending legacy fields or unrelated secrets', async () => {
    const settings = Vue.ref({gatewayEnabled: 0, gatewayHostname: '', title: 'Existing', smtpChannels: {synthetic: 'do-not-resend'}})
    const calls = []
    const state = useGatewayAdminSettings(settings, async patch => calls.push(patch))
    state.enabled.value = 1
    state.imapHostname.value = ' IMAP.Example.Invalid '
    state.smtpHostname.value = ' SMTP.Example.Invalid '
    assert.equal(await state.save(), true)
    assert.deepEqual(calls, [split])
    assert.equal(settings.value.title, 'Existing')
    assert.deepEqual(settings.value.smtpChannels, {synthetic: 'do-not-resend'})
    assert.equal(settings.value.gatewayHostname, '')
    assert.equal(gatewayDisplayConfig(settings.value).enabled, true)
    state.enabled.value = 0
    assert.equal(await state.save(), true)
    assert.deepEqual(calls[1], {gatewayEnabled: 0})
    state.dispose()
})

for (const [draft, field] of [['imapHostname', 'gatewayImapHostname'], ['smtpHostname', 'gatewaySmtpHostname']]) {
    test(`changing ${field} submits only that field and preserves the other endpoint`, async () => {
        const settings = Vue.ref({...split})
        const calls = []
        const state = useGatewayAdminSettings(settings, async patch => calls.push(patch))
        state[draft].value = 'changed.example.invalid'
        assert.equal(await state.save(), true)
        assert.deepEqual(calls, [{gatewayEnabled: 1, [field]: 'changed.example.invalid'}])
        assert.deepEqual(settings.value, {...split, [field]: 'changed.example.invalid'})
        state.dispose()
    })
}

test('old shared settings do not prefill admin fields; both endpoints must be configured afresh', async () => {
    const settings = Vue.ref({gatewayEnabled: 1, gatewayHostname: 'legacy.example.invalid'})
    const calls = []
    const state = useGatewayAdminSettings(settings, async patch => calls.push(patch))
    assert.equal(state.imapHostname.value, '')
    assert.equal(state.smtpHostname.value, '')
    state.smtpHostname.value = split.gatewaySmtpHostname
    assert.equal(await state.save(), false)
    assert.deepEqual(calls, [])
    state.imapHostname.value = split.gatewayImapHostname
    assert.equal(await state.save(), true)
    assert.deepEqual(calls, [split])
    assert.equal(gatewayDisplayConfig(settings.value).imapHostname, split.gatewayImapHostname)
    state.dispose()
})

test('saving endpoint names while the displayed switch is off explicitly keeps the feature disabled', async () => {
    const settings = Vue.ref({gatewayEnabled: 0, gatewayImapHostname: '', gatewaySmtpHostname: ''})
    const calls = []
    const state = useGatewayAdminSettings(settings, async patch => calls.push(patch))
    state.imapHostname.value = split.gatewayImapHostname
    state.smtpHostname.value = split.gatewaySmtpHostname
    assert.equal(await state.save(), true)
    assert.deepEqual(calls, [{...split, gatewayEnabled: 0}])
    assert.equal(gatewayDisplayConfig(settings.value).enabled, false)
    state.dispose()
})

test('unchanged saves do not send a broad settings snapshot', async () => {
    let calls = 0
    const state = useGatewayAdminSettings(Vue.ref({...split}), async () => {calls++})
    assert.equal(await state.save(), true)
    assert.equal(calls, 0)
    state.dispose()
})

test('invalid or failed saves cannot advertise unsaved settings as enabled', async () => {
    const settings = Vue.ref({gatewayEnabled: 0, gatewayHostname: ''})
    let calls = 0
    const state = useGatewayAdminSettings(settings, async () => {calls++; throw {config: {password: 'synthetic'}}})
    state.enabled.value = 1
    state.imapHostname.value = split.gatewayImapHostname
    assert.equal(await state.save(), false)
    assert.equal(calls, 0)
    assert.equal(state.errorKey.value, 'gatewayAdminInvalidHostname')
    state.smtpHostname.value = split.gatewaySmtpHostname
    assert.equal(await state.save(), false)
    assert.equal(calls, 1)
    assert.equal(state.errorKey.value, 'gatewayAdminSaveFailed')
    assert.deepEqual(settings.value, {gatewayEnabled: 0, gatewayHostname: ''})
    assert.equal(state.saving.value, false)
    state.dispose()
})

test('pending saves cannot duplicate requests or overwrite updates to the untouched hostname', async () => {
    const settings = Vue.ref({...split})
    let finish
    let calls = 0
    const state = useGatewayAdminSettings(settings, () => {calls++; return new Promise(resolve => {finish = resolve})})
    state.imapHostname.value = 'changed.example.invalid'
    const first = state.save()
    assert.equal(state.saving.value, true)
    assert.equal(await state.save(), false)
    assert.equal(calls, 1)
    assert.equal(settings.value.gatewayImapHostname, split.gatewayImapHostname)
    settings.value.gatewaySmtpHostname = 'other-update.example.invalid'
    await Vue.nextTick()
    finish()
    assert.equal(await first, true)
    assert.equal(settings.value.gatewaySmtpHostname, 'other-update.example.invalid')
    assert.equal(state.smtpHostname.value, 'other-update.example.invalid')
    state.dispose()
})

test('updated public settings synchronize both drafts without collecting unrelated secrets', async () => {
    const settings = Vue.ref({gatewayEnabled: 0, gatewayHostname: ''})
    const state = useGatewayAdminSettings(settings, async () => {})
    settings.value = {...split, secretKey: 'synthetic'}
    await Vue.nextTick()
    assert.equal(state.enabled.value, 1)
    assert.equal(state.imapHostname.value, split.gatewayImapHostname)
    assert.equal(state.smtpHostname.value, split.gatewaySmtpHostname)
    state.dispose()
})

test('all affected SFCs compile, localized labels match and hostname configuration does not imply DNS/TLS provisioning', () => {
    for (const source of [admin, client, personal, read('../src/views/sys-setting/index.vue')]) {
        const {descriptor, errors} = parse(source)
        assert.deepEqual(errors, [])
        const script = compileScript(descriptor, {id: 'gateway-config-test'})
        assert.deepEqual(compileTemplate({source: descriptor.template.content, filename: 'config.vue', id: 'gateway-config-test',
            compilerOptions: {bindingMetadata: script.bindings}}).errors, [])
    }
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
    for (const key of ['gatewayImapServer', 'gatewaySmtpServer', 'gatewayAdminImapHostnamePlaceholder', 'gatewayAdminSmtpHostnamePlaceholder']) assert.ok(zh[key] && en[key])
    assert.match(zh.gatewayAdminHostnameHint, /不会自动配置 DNS 或证书/)
    assert.match(en.gatewayAdminHostnameHint, /does not configure DNS or certificates/)
    assert.match(read('../src/views/sys-setting/index.vue'), /<GatewayAdminSettings :disabled="settingLoading \|\| !settingReady" @saving="settingLoading = \$event"/)
})
