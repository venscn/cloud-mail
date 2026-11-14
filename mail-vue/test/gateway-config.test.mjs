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

test('public gateway settings fail closed for absent, disabled or malformed configuration', () => {
    for (const settings of [undefined, {}, {gatewayEnabled: 0, gatewayHostname: 'imap.example.invalid'},
        {gatewayEnabled: '1', gatewayHostname: 'imap.example.invalid'}, {gatewayEnabled: true, gatewayHostname: 'imap.example.invalid'},
        {gatewayEnabled: 1}, {gatewayEnabled: 1, gatewayHostname: 'https://imap.example.invalid'}]) {
        assert.deepEqual(gatewayDisplayConfig(settings), {enabled: false, hostname: ''})
    }
    assert.deepEqual(gatewayDisplayConfig({gatewayEnabled: 1, gatewayHostname: ' IMAP.Example.Invalid '}), {enabled: true, hostname: 'imap.example.invalid'})
})

test('hostname validation rejects schemes, ports, paths, IPs, control characters and invalid DNS labels', () => {
    for (const value of ['https://imap.example.invalid', 'imap.example.invalid:993', 'imap.example.invalid/a', 'a@b.example',
        '127.0.0.1', '[::1]', 'localhost', '-a.example', 'a-.example', 'a..example', 'a_.example', 'a.example.',
        '\nimap.example.invalid', 'imap.example.invalid\r', '<img src=x>.example', '邮箱.example', 'a'.repeat(64)+'.example']) {
        assert.equal(normalizeGatewayHostname(value), null, JSON.stringify(value))
        assert.equal(gatewaySettingsPatch(1, value), null)
    }
    assert.equal(normalizeGatewayHostname(''), '')
    assert.equal(gatewaySettingsPatch(1, ''), null)
    assert.equal(gatewaySettingsPatch('1', 'imap.example.invalid'), null)
    assert.deepEqual(gatewaySettingsPatch(0, ''), {gatewayEnabled: 0, gatewayHostname: ''})
})

test('the production personal-settings condition never mounts disabled gateway management', async () => {
    const {descriptor} = parse(personal)
    const gateway = find(descriptor.template.ast, node => node.tag === 'GatewaySettings')
    assert.ok(gateway)
    const render = renderTemplate(gateway.loc.source)
    for (const enabled of [undefined, 0, '1', 1]) {
        let mounted = 0
        const settings = {gatewayEnabled: enabled, gatewayHostname: 'imap.example.invalid'}
        const app = Vue.createSSRApp({setup: () => ({gatewayConfig: gatewayDisplayConfig(settings)}), render})
        app.component('GatewaySettings', {setup() {mounted++; return () => Vue.h('section', 'client settings')}})
        const html = await renderToString(app)
        assert.equal(mounted, enabled === 1 ? 1 : 0)
        assert.equal(html.includes('client settings'), enabled === 1)
    }
})

test('gateway placement follows Other/notice and immediately precedes account deletion', () => {
    const gateway = personal.indexOf('<GatewaySettings')
    assert.ok(gateway > personal.indexOf("$t('noticeTitle')"))
    assert.ok(gateway < personal.indexOf('<div class="del-email"'))
    assert.match(personal.slice(gateway, personal.indexOf('<div class="del-email"')), /^<GatewaySettings[^>]+\/>\s*$/)
    assert.match(personal, /gatewayDisplayConfig\(settingStore\.settings\)/)
})

test('users see the configured hostname, not deployment instructions or a website-domain guess', () => {
    assert.doesNotMatch(client, /gatewayDeploymentRequired|gatewayServerHint|window\.location/)
    assert.match(client, /data-testid="gateway-hostname">\{\{ gatewayHostname \}\}/)
    assert.match(client, /gatewayDisplayConfig\(settingStore\.settings\)/)
    assert.match(client, /gatewayIosStep2', \{hostname: gatewayHostname\}/)
    assert.match(admin, /gatewayDeploymentRequired/)
    assert.match(admin, /gatewayAdminEnabled/)
    assert.match(admin, /v-model="hostname"/)
})

test('admin saves only the two public gateway fields and preserves other settings', async () => {
    const settings = Vue.ref({gatewayEnabled: 0, gatewayHostname: '', title: 'Existing', smtpChannels: {synthetic: 'do-not-resend'}})
    const calls = []
    const state = useGatewayAdminSettings(settings, async patch => calls.push(patch))
    state.enabled.value = 1
    state.hostname.value = ' IMAP.Example.Invalid '
    assert.equal(await state.save(), true)
    assert.deepEqual(calls, [{gatewayEnabled: 1, gatewayHostname: 'imap.example.invalid'}])
    assert.equal(settings.value.title, 'Existing')
    assert.deepEqual(settings.value.smtpChannels, {synthetic: 'do-not-resend'})
    assert.equal(gatewayDisplayConfig(settings.value).enabled, true)
    state.enabled.value = 0
    assert.equal(await state.save(), true)
    assert.equal(gatewayDisplayConfig(settings.value).enabled, false)
    state.dispose()
})

test('invalid or failed admin saves never advertise an unsaved feature as enabled', async () => {
    const settings = Vue.ref({gatewayEnabled: 0, gatewayHostname: ''})
    let calls = 0
    const state = useGatewayAdminSettings(settings, async () => {calls++; throw {config: {password: 'synthetic'}}})
    state.enabled.value = 1
    assert.equal(await state.save(), false)
    assert.equal(calls, 0)
    assert.equal(state.errorKey.value, 'gatewayAdminInvalidHostname')
    state.hostname.value = 'imap.example.invalid'
    assert.equal(await state.save(), false)
    assert.equal(calls, 1)
    assert.equal(state.errorKey.value, 'gatewayAdminSaveFailed')
    assert.deepEqual(settings.value, {gatewayEnabled: 0, gatewayHostname: ''})
    assert.equal(state.saving.value, false)
    state.dispose()
})

test('pending saves are not duplicated and do not optimistically change the public configuration', async () => {
    const settings = Vue.ref({gatewayEnabled: 0, gatewayHostname: ''})
    let finish
    let calls = 0
    const state = useGatewayAdminSettings(settings, () => {calls++; return new Promise(resolve => {finish = resolve})})
    state.enabled.value = 1
    state.hostname.value = 'imap.example.invalid'
    const first = state.save()
    assert.equal(state.saving.value, true)
    assert.equal(await state.save(), false)
    assert.equal(calls, 1)
    assert.equal(gatewayDisplayConfig(settings.value).enabled, false)
    finish()
    assert.equal(await first, true)
    assert.equal(gatewayDisplayConfig(settings.value).enabled, true)
    state.dispose()
})

test('changed administrator settings update the draft without collecting unrelated secrets', async () => {
    const settings = Vue.ref({gatewayEnabled: 0, gatewayHostname: ''})
    const state = useGatewayAdminSettings(settings, async () => {})
    settings.value = {gatewayEnabled: 1, gatewayHostname: 'new.example.invalid', secretKey: 'synthetic'}
    await Vue.nextTick()
    assert.equal(state.enabled.value, 1)
    assert.equal(state.hostname.value, 'new.example.invalid')
    state.dispose()
})

test('admin and personal SFCs compile and localized labels have parity', () => {
    for (const source of [admin, personal, read('../src/views/sys-setting/index.vue')]) {
        const {descriptor, errors} = parse(source)
        assert.deepEqual(errors, [])
        const script = compileScript(descriptor, {id: 'gateway-config-test'})
        const template = compileTemplate({source: descriptor.template.content, filename: 'config.vue', id: 'gateway-config-test', compilerOptions: {bindingMetadata: script.bindings}})
        assert.deepEqual(template.errors, [])
    }
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
    for (const key of ['gatewayAdminEnabled', 'gatewayAdminHostnameHint', 'gatewayAdminInvalidHostname', 'gatewayAdminSaveFailed']) {
        assert.ok(zh[key] && en[key])
    }
    const system = read('../src/views/sys-setting/index.vue')
    assert.match(system, /<GatewayAdminSettings :disabled="settingLoading \|\| !settingReady" @saving="settingLoading = \$event"/)
})
