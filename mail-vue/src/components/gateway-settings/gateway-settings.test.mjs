import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {parse, compileScript, compileTemplate} from 'vue/compiler-sfc'
import {createGatewayManagementApi, GatewayManagementError, normalizeGatewayResponse} from '../../request/gateway-client.js'
import {accountsFromResponse, appPasswordsFromResponse, gatewayErrorKey, submissionsFromResponse, submissionPresentation} from './gateway-model.js'
import {useGatewaySettings} from './use-gateway-settings.js'
import zh from '../../i18n/gateway-zh.js'
import en from '../../i18n/gateway-en.js'

const secret = 'synthetic-app-password-not-a-real-credential'
const account = {accountId: '11', email: 'reader@example.invalid', name: 'Synthetic reader'}
const metadata = {id: 'credential-1', accountId: '11', mailboxAddress: account.email, name: 'My device', createdAt: '2030-01-01T00:00:00Z', permissions: ['mail.read', 'mail.write']}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return {promise, resolve} }
function makeApi(overrides = {}) {
    return {
        accounts: async () => [account], appPasswords: async () => [metadata], submissions: async () => [],
        createAppPassword: async data => ({...metadata, ...data, password: secret}),
        revokeAppPassword: async () => ({revoked: true}), ...overrides,
    }
}

for (const status of [401, 403, 404, 429, 500, 503]) {
    test(`HTTP ${status} is not transformed into success or an unsafe error`, () => {
        assert.deepEqual(normalizeGatewayResponse(JSON.stringify({code: 200, data: {password: secret}, message: secret}), {}, status), {code: status})
    })
}

test('Result errors and malformed/HTML responses remain failures without retaining payloads', () => {
    assert.deepEqual(normalizeGatewayResponse('<html>unavailable</html>', {}, 200), {code: 502})
    assert.deepEqual(normalizeGatewayResponse('{"code":403,"message":"private"}', {}, 200), {code: 403})
    assert.deepEqual(normalizeGatewayResponse('{"data":[]}', {}, 200), {code: 502})
    assert.deepEqual(normalizeGatewayResponse('{"code":200,"data":[]}', {}, 200), {code: 200, data: []})
})

test('management requests reuse website authentication without setting Bearer or forcing 403 reload', async () => {
    const requests = []
    const http = {request: async config => { requests.push(config); return [] }}
    const api = createGatewayManagementApi(http)
    await api.accounts(); await api.appPasswords()
    await api.createAppPassword({accountId: '11', name: 'Device', permissions: ['mail.read']})
    await api.revokeAppPassword('entry/with space')
    await api.submissions('11')
    assert.deepEqual(requests.map(request => request.url), ['/gateway/accounts', '/gateway/app-passwords', '/gateway/app-passwords', '/gateway/app-passwords/entry%2Fwith%20space', '/gateway/submissions'])
    assert.deepEqual(requests[4].params, {accountId: '11'})
    for (const request of requests) {
        assert.equal(request.noMsg, true)
        assert.equal(request.validateStatus(403), true)
        assert.equal(request.headers.Authorization, undefined)
        assert.equal(request.headers['Cache-Control'], 'no-store')
        assert.equal(request.transformResponse[0], normalizeGatewayResponse)
    }
})

test('transport failures discard Axios headers, request configs, response bodies and secrets', async () => {
    const api = createGatewayManagementApi({request: async () => { throw {response: {status: 503, data: {password: secret}}, config: {headers: {Authorization: secret}}} }})
    await assert.rejects(api.accounts(), error => {
        assert.ok(error instanceof GatewayManagementError)
        assert.equal(error.status, 503)
        assert.equal(JSON.stringify(error).includes(secret), false)
        assert.equal(error.config, undefined)
        return true
    })
})

test('list models whitelist fields and never persist password, raw MIME or upstream errors', () => {
    const input = {...metadata, password: secret, token: secret, mime: secret, error: secret, permissions: ['mail.read', 'admin']}
    const mapped = appPasswordsFromResponse([input])
    assert.equal(JSON.stringify(mapped).includes(secret), false)
    assert.deepEqual(mapped[0].permissions, ['mail.read'])
    assert.deepEqual(accountsFromResponse([{...account, password: secret}]), [account])
    assert.throws(() => accountsFromResponse({accounts: [account]}))
})

test('a created password is shown once only in local secret state and never copied to a list', async () => {
    let calls = 0
    const state = useGatewaySettings(makeApi({createAppPassword: async data => { calls++; return {...metadata, ...data, password: secret} }}))
    await state.refresh()
    state.credentialName.value = 'My iPhone'
    assert.equal(await state.create(), true)
    assert.equal(state.oneTimeSecret.value.password, secret)
    assert.equal(JSON.stringify(state.appPasswords.value).includes(secret), false)
    assert.equal(await state.create(), false)
    assert.equal(calls, 1)
    state.clearSecret()
    assert.equal(state.oneTimeSecret.value, null)
    await state.refresh()
    assert.equal(state.oneTimeSecret.value, null)
    state.dispose()
})

test('unmount clears credentials and ignores/aborts a late password-creation response', async () => {
    const result = deferred()
    let signal
    const state = useGatewaySettings(makeApi({createAppPassword: async (_data, requestSignal) => { signal = requestSignal; return result.promise }}))
    await state.refresh()
    state.credentialName.value = 'Device'
    const creation = state.create()
    state.dispose()
    assert.equal(signal.aborted, true)
    result.resolve({...metadata, password: secret})
    await creation
    assert.equal(state.oneTimeSecret.value, null)
    assert.deepEqual(state.appPasswords.value, [])
})

test('deactivation/secret clearing prevents a pending response from reopening the one-time dialog', async () => {
    const result = deferred()
    const state = useGatewaySettings(makeApi({createAppPassword: async () => result.promise}))
    await state.refresh()
    state.credentialName.value = 'Device'
    const creation = state.create()
    state.clearSecret()
    result.resolve({...metadata, password: secret})
    assert.equal(await creation, false)
    assert.equal(state.oneTimeSecret.value, null)
    assert.equal(state.createOutcomeUnknown.value, true)
    assert.equal(JSON.stringify(state.appPasswords.value).includes(secret), false)
    state.dispose()
})

test('a password response bound to another mailbox cannot expose a secret', async () => {
    const state = useGatewaySettings(makeApi({createAppPassword: async () => ({...metadata, accountId: '22', password: secret})}))
    await state.refresh()
    state.credentialName.value = 'Device'
    assert.equal(await state.create(), false)
    assert.equal(state.oneTimeSecret.value, null)
    assert.equal(state.createOutcomeUnknown.value, true)
    state.dispose()
})

test('no eligible account prevents creation and does not request submissions', async () => {
    let calls = 0
    const state = useGatewaySettings(makeApi({accounts: async () => [], submissions: async () => { calls++; return [] }}))
    await state.refresh()
    assert.equal(state.ready.value, true)
    assert.equal(state.selectedAccountId.value, '')
    state.credentialName.value = 'Device'
    assert.equal(await state.create(), false)
    assert.equal(calls, 0)
    state.dispose()
})

test('loss of account-query permission still permits listing/revoking existing own credentials', async () => {
    let revoked = ''
    const state = useGatewaySettings(makeApi({accounts: async () => { throw new GatewayManagementError(403) }, revokeAppPassword: async id => { revoked = id; return {revoked: true} }}))
    await state.refresh()
    assert.equal(state.ready.value, true)
    assert.equal(state.accountsErrorKey.value, 'gatewayForbidden')
    assert.equal(state.visibleAppPasswords.value.length, 1)
    assert.equal(await state.revoke(metadata.id), true)
    assert.equal(revoked, metadata.id)
    assert.ok(state.appPasswords.value[0].revokedAt)
    assert.equal(await state.create(), false)
    state.dispose()
})

test('uninitialized backend 503 is unavailable, not empty/ready or client-connect success', async () => {
    const unavailable = async () => { throw new GatewayManagementError(503) }
    const state = useGatewaySettings(makeApi({accounts: unavailable, appPasswords: unavailable}))
    await state.refresh()
    assert.equal(state.ready.value, false)
    assert.equal(state.errorKey.value, 'gatewayUnavailable')
    assert.equal(await state.create(), false)
    state.dispose()
})

test('ambiguous creation failure does not retry and advises refresh/revoke', async () => {
    let calls = 0
    const state = useGatewaySettings(makeApi({createAppPassword: async () => { calls++; throw new GatewayManagementError(0) }}))
    await state.refresh()
    state.credentialName.value = 'Device'
    assert.equal(await state.create(), false)
    assert.equal(calls, 1)
    assert.equal(state.createOutcomeUnknown.value, true)
    assert.equal(state.oneTimeSecret.value, null)
    assert.equal(state.actionErrorKey.value, 'gatewayUnavailable')
    state.dispose()
})

test('creation sends only granted requested scopes and the selected own account', async () => {
    let sent
    const state = useGatewaySettings(makeApi({createAppPassword: async data => { sent = data; return {...metadata, ...data, password: secret} }}))
    await state.refresh()
    state.credentialName.value = ' Device '
    state.requestedPermissions.value = ['mail.read', 'mail.write', 'mail.send', 'admin']
    await state.create(['mail.read', 'mail.write'])
    assert.deepEqual(sent, {accountId: '11', name: 'Device', permissions: ['mail.read', 'mail.write']})
    state.dispose()
})

test('revocation is successful only with explicit server confirmation', async () => {
    const state = useGatewaySettings(makeApi({revokeAppPassword: async () => ({revoked: false})}))
    await state.refresh()
    assert.equal(await state.revoke(metadata.id), false)
    assert.equal(state.appPasswords.value[0].revokedAt, '')
    state.dispose()
})

test('account switches discard stale submission responses and cross-account entries', async () => {
    const oldResult = deferred()
    let first = true
    const state = useGatewaySettings(makeApi({
        accounts: async () => [account, {...account, accountId: '22', email: 'other@example.invalid'}],
        submissions: async accountId => {
            if (first) { first = false; return oldResult.promise }
            return [{id: 'other-mailbox', accountId: '11', state: 'sent'}, {id: 'correct', accountId, state: 'unknown', raw: secret}]
        },
    }))
    const loading = state.refresh()
    // Allow account/password requests to resolve, without using real timers.
    for (let index = 0; index < 8; index++) await Promise.resolve()
    await state.selectAccount('22')
    oldResult.resolve([{id: 'stale', accountId: '11', state: 'sent'}])
    await loading
    assert.deepEqual(state.submissions.value.map(item => item.id), ['correct'])
    assert.equal(JSON.stringify(state.submissions.value).includes(secret), false)
    state.dispose()
})

test('submissions are capped, whitelisted and unknown states never appear as sent', () => {
    const response = Array.from({length: 70}, (_, index) => ({id: String(index), accountId: '11', state: 'unexpected', mime: secret}))
    const submissions = submissionsFromResponse(response, '11')
    assert.equal(submissions.length, 50)
    assert.ok(submissions.every(item => item.state === 'unknown'))
    assert.equal(JSON.stringify(submissions).includes(secret), false)
    assert.deepEqual(submissionPresentation('unexpected'), submissionPresentation('unknown'))
    assert.equal(submissionPresentation('sent').label, 'gatewayState_sent')
})

test('partial/contradictory recipient outcomes cannot be displayed as complete success', () => {
    const [result] = submissionsFromResponse([{id: 'partial', accountId: '11', state: 'sent', recipients: [
        {address: 'one@example.invalid', state: 'accepted', error: secret},
        {address: 'two@example.invalid', state: 'unknown', raw: secret},
    ]}], '11')
    assert.equal(result.partial, true)
    assert.equal(result.state, 'unknown')
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(result.recipients[1].state, 'unknown')
})

test('authentication and unavailable errors have accurate localized classifications', () => {
    assert.equal(gatewayErrorKey(new GatewayManagementError(401)), 'gatewaySignInRequired')
    assert.equal(gatewayErrorKey(new GatewayManagementError(403)), 'gatewayForbidden')
    assert.equal(gatewayErrorKey(new GatewayManagementError(404)), 'gatewayUnavailable')
    assert.equal(gatewayErrorKey(new GatewayManagementError(429)), 'gatewayRateLimited')
})

test('component compiles, has localized safe client guidance and no persistence/logging sinks', async () => {
    const source = await readFile(new URL('./index.vue', import.meta.url), 'utf8')
    const controller = await readFile(new URL('./use-gateway-settings.js', import.meta.url), 'utf8')
    const {descriptor, errors} = parse(source)
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, {id: 'gateway-settings-test'})
    const template = compileTemplate({source: descriptor.template.content, filename: 'gateway-settings.vue', id: 'gateway-settings-test', compilerOptions: {bindingMetadata: script.bindings}})
    assert.deepEqual(template.errors, [])
    assert.doesNotMatch(source + controller, /localStorage|sessionStorage|defineStore|console\.|v-html|dangerouslyUseHTMLString/)
    assert.match(source, /v-if="oneTimeSecret"/)
    assert.match(source, /onBeforeUnmount\(state\.dispose\)/)
    assert.match(source, /@close="clearSecret"/)
    assert.match(source, /gatewayUnknownWarning/)
    assert.doesNotMatch(source, /gatewayDeploymentRequired|gatewayServerHint/)
    assert.match(source, /data-testid="gateway-imap-hostname"/)
    assert.match(source, /data-testid="gateway-smtp-hostname"/)
    assert.match(source, /gatewayDisplayConfig\(settingStore\.settings\)/)
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
    for (const key of (source + controller).matchAll(/['"](gateway[A-Z_a-z]+)['"]/g)) {
        if (key[1] === 'gateway-settings-test') continue
        assert.ok(key[1] in zh, `Missing translation: ${key[1]}`)
    }
    const settings = await readFile(new URL('../../views/setting/index.vue', import.meta.url), 'utf8')
    assert.match(settings, /<GatewaySettings/)
    assert.match(settings, /v-if="settingStore\.settings\.notice === 0"/)
    assert.match(settings, /v-perm="'my:delete'"/)
})
