import {ref, watch} from 'vue'
import {gatewaySettingsPatch} from '../gateway-settings/gateway-config.js'

export function useGatewayAdminSettings(settings, update) {
    const enabled = ref(0)
    const hostname = ref('')
    const saving = ref(false)
    const errorKey = ref('')
    const stop = watch(() => [settings.value?.gatewayEnabled, settings.value?.gatewayHostname], ([value, host]) => {
        if (!saving.value) {
            enabled.value = value === 1 ? 1 : 0
            hostname.value = typeof host === 'string' ? host : ''
        }
    }, {immediate: true})

    async function save() {
        if (saving.value) return false
        errorKey.value = ''
        const patch = gatewaySettingsPatch(enabled.value, hostname.value)
        if (!patch) {
            errorKey.value = 'gatewayAdminInvalidHostname'
            return false
        }
        saving.value = true
        try {
            // Send only these public settings; never resend masked admin secrets.
            await update(patch)
            Object.assign(settings.value, patch)
            enabled.value = patch.gatewayEnabled
            hostname.value = patch.gatewayHostname
            return true
        } catch {
            // Do not retain an Axios response/config, which may contain secrets.
            errorKey.value = 'gatewayAdminSaveFailed'
            return false
        } finally {
            saving.value = false
        }
    }
    return {enabled, hostname, saving, errorKey, save, dispose: stop}
}
