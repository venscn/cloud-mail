import {reactive, watch} from 'vue'
const codes = new Set(['OK','INVALID_REQUEST','FORBIDDEN','SESSION_INVALID','NOT_CONFIGURED','RATE_LIMITED','DNS_FAILED','ADDRESS_BLOCKED','CONNECT_TLS_FAILED','PROTOCOL_FAILED','LIMIT_EXCEEDED','TIMEOUT','CANCELLED','UNAVAILABLE'])
const phases = ['dns','secureConnection','protocol']
export function useGatewayConnectivity(settings, drafts, saving, request, disabled = () => false) {
    const tests = reactive({imap:{pending:false,result:null,code:'',cooldown:false},smtp:{pending:false,result:null,code:'',cooldown:false}})
    const versions = {imap:0,smtp:0}, controllers = {}, timers = {}
    let disposed = false
    const field = protocol => protocol === 'imap' ? 'gatewayImapHostname' : 'gatewaySmtpHostname'
    const dirty = protocol => drafts[protocol].value !== (settings.value?.[field(protocol)] || '')
    const stops = ['imap','smtp'].map(protocol => watch(() => [drafts[protocol].value,settings.value?.[field(protocol)]], () => {
        versions[protocol]++; tests[protocol].result = null; tests[protocol].code = ''; controllers[protocol]?.abort()
    }, {flush:'sync'}))
    const blocked = protocol => disabled() || saving.value || tests[protocol].pending || tests[protocol].cooldown || dirty(protocol) || !settings.value?.[field(protocol)]
    async function testConnection(protocol) {
        if (!Object.hasOwn(tests,protocol) || disposed || blocked(protocol)) return false
        const state = tests[protocol], version = versions[protocol]
        const controller = new AbortController(); controllers[protocol] = controller
        state.pending = true; state.result = null; state.code = ''; state.cooldown = true
        clearTimeout(timers[protocol]); timers[protocol] = setTimeout(() => {state.cooldown = false},60000)
        try {
            const response = await request(protocol,controller.signal)
            if (disposed || version !== versions[protocol]) return false
            const code = codes.has(response?.code) ? response.code : 'UNAVAILABLE'
            const valid = phases.every(phase => ['passed','failed','pending'].includes(response?.stages?.[phase]))
            const ok = response?.ok === true && code === 'OK' && valid && phases.every(phase => response.stages[phase] === 'passed')
            state.code = code === 'OK' && !ok ? 'UNAVAILABLE' : code
            state.result = valid ? {ok,stages:Object.fromEntries(phases.map(phase => [phase,response.stages[phase]]))} : null
            return ok
        } catch (error) {
            if (!disposed && version === versions[protocol]) {
                // Whitelist only; do not retain Axios config, banner, response or raw message.
                state.code = codes.has(error?.message) && error.message !== 'OK' ? error.message : 'UNAVAILABLE'
            }
            return false
        } finally { state.pending = false; if (controllers[protocol] === controller) delete controllers[protocol] }
    }
    function dispose() {disposed = true; stops.forEach(stop => stop()); for (const protocol of ['imap','smtp']) {controllers[protocol]?.abort(); clearTimeout(timers[protocol])}}
    return {tests,dirty,blocked,testConnection,dispose}
}
