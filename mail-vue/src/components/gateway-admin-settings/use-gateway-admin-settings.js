import {ref, watch} from 'vue'
import {gatewaySettingsPatch} from '../gateway-settings/gateway-config.js'

export function useGatewayAdminSettings(settings, update) {
    const enabled = ref(0)
    const imapHostname = ref('')
    const smtpHostname = ref('')
    const saving = ref(false)
    const errorKey = ref('')
    let baseline = {}
    function syncDraft() {
        const current = settings.value
        const imap = current?.gatewayImapHostname
        const smtp = current?.gatewaySmtpHostname
        enabled.value = current?.gatewayEnabled === 1 ? 1 : 0
        imapHostname.value = typeof imap === 'string' ? imap : ''
        smtpHostname.value = typeof smtp === 'string' ? smtp : ''
        baseline = {gatewayEnabled: enabled.value, gatewayImapHostname: imapHostname.value, gatewaySmtpHostname: smtpHostname.value}
    }
    const stop = watch(() => [settings.value?.gatewayEnabled,
        settings.value?.gatewayImapHostname, settings.value?.gatewaySmtpHostname], () => {
        if (!saving.value) syncDraft()
    }, {immediate: true})

    async function save() {
        if (saving.value) return false
        errorKey.value = ''
        const normalized = gatewaySettingsPatch(enabled.value, imapHostname.value, smtpHostname.value)
        if (!normalized) {
            errorKey.value = 'gatewayAdminInvalidHostname'
            return false
        }
        // Only dirty hostnames; never resend the other endpoint or masked secrets.
        const changes = Object.fromEntries(Object.entries(normalized).filter(([key, value]) => value !== baseline[key]))
        if (!Object.keys(changes).length) return true
        // Explicitly preserve the displayed switch when the server normalized an incomplete old config to off.
        const patch = {gatewayEnabled: normalized.gatewayEnabled, ...changes}
        saving.value = true
        try {
            await update(patch)
            Object.assign(settings.value, patch)
            syncDraft()
            return true
        } catch {
            // Do not retain an Axios response/config, which may contain secrets.
            errorKey.value = 'gatewayAdminSaveFailed'
            return false
        } finally {
            saving.value = false
        }
    }
    return {enabled, imapHostname, smtpHostname, saving, errorKey, save, dispose: stop}
}
