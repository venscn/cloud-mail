import {computed, ref, shallowRef} from 'vue'
import {accountsFromResponse, appPasswordsFromResponse, gatewayErrorKey, GATEWAY_PERMISSIONS, submissionsFromResponse} from './gateway-model.js'

// All state is component-local and disposable. In particular, the one-time
// secret is never put in an account store, persisted settings or error message.
export function useGatewaySettings(api) {
    const accounts = ref([])
    const appPasswords = ref([])
    const submissions = ref([])
    const selectedAccountId = ref('')
    const loading = ref(false)
    const creating = ref(false)
    const revokingId = ref('')
    const submissionsLoading = ref(false)
    const errorKey = ref('')
    const accountsErrorKey = ref('')
    const actionErrorKey = ref('')
    const submissionsErrorKey = ref('')
    const createOutcomeUnknown = ref(false)
    const ready = ref(false)
    const oneTimeSecret = shallowRef(null)
    const credentialName = ref('')
    const requestedPermissions = ref(['mail.read', 'mail.write'])
    const selectedAccount = computed(() => accounts.value.find(account => account.accountId === selectedAccountId.value))
    const visibleAppPasswords = computed(() => appPasswords.value.filter(credential =>
        !selectedAccountId.value || credential.accountId === selectedAccountId.value))
    let disposed = false
    let secretGeneration = 0
    let submissionGeneration = 0
    let submissionController
    const controllers = new Set()

    async function run(callback) {
        const controller = new AbortController()
        controllers.add(controller)
        try {
            return await callback(controller.signal)
        } finally {
            controllers.delete(controller)
        }
    }

    function clearSecret() {
        ++secretGeneration
        oneTimeSecret.value = null
    }

    async function refreshSubmissions() {
        const generation = ++submissionGeneration
        submissionController?.abort()
        submissionController = undefined
        submissions.value = []
        submissionsErrorKey.value = ''
        submissionsLoading.value = false
        const accountId = selectedAccountId.value
        if (disposed || !ready.value || !accountId) return
        const controller = new AbortController()
        submissionController = controller
        submissionsLoading.value = true
        try {
            const response = await api.submissions(accountId, controller.signal)
            if (!disposed && generation === submissionGeneration) {
                submissions.value = submissionsFromResponse(response, accountId)
            }
        } catch (error) {
            if (!disposed && generation === submissionGeneration) submissionsErrorKey.value = gatewayErrorKey(error)
        } finally {
            if (!disposed && generation === submissionGeneration) submissionsLoading.value = false
        }
    }

    async function selectAccount(accountId) {
        clearSecret()
        selectedAccountId.value = accounts.value.some(account => account.accountId === String(accountId)) ? String(accountId) : ''
        actionErrorKey.value = ''
        createOutcomeUnknown.value = false
        await refreshSubmissions()
    }

    async function refresh() {
        if (disposed || loading.value || creating.value || revokingId.value) return
        loading.value = true
        errorKey.value = ''
        accountsErrorKey.value = ''
        actionErrorKey.value = ''
        createOutcomeUnknown.value = false
        try {
            const [accountResult, passwordResult] = await run(signal => Promise.allSettled([
                api.accounts(signal), api.appPasswords(signal),
            ]))
            if (disposed) return
            // Listing/revoking one's existing credentials remains possible even
            // after the current role loses access to gateway accounts.
            if (passwordResult.status === 'rejected') throw passwordResult.reason
            let nextAccounts = []
            if (accountResult.status === 'fulfilled') nextAccounts = accountsFromResponse(accountResult.value)
            else accountsErrorKey.value = gatewayErrorKey(accountResult.reason)
            const nextPasswords = appPasswordsFromResponse(passwordResult.value)
            accounts.value = nextAccounts
            appPasswords.value = nextPasswords
            ready.value = true
            const accountId = nextAccounts.some(account => account.accountId === selectedAccountId.value)
                ? selectedAccountId.value : nextAccounts[0]?.accountId || ''
            await selectAccount(accountId)
        } catch (error) {
            if (disposed) return
            clearSecret()
            ready.value = false
            accounts.value = []
            appPasswords.value = []
            selectedAccountId.value = ''
            await refreshSubmissions()
            errorKey.value = gatewayErrorKey(error)
        } finally {
            if (!disposed) loading.value = false
        }
    }

    async function create(allowedPermissions = GATEWAY_PERMISSIONS) {
        if (disposed || creating.value || loading.value || !ready.value || oneTimeSecret.value) return false
        actionErrorKey.value = ''
        createOutcomeUnknown.value = false
        const name = credentialName.value.trim()
        const permissions = GATEWAY_PERMISSIONS.filter(permission => requestedPermissions.value.includes(permission) && allowedPermissions.includes(permission))
        if (!selectedAccount.value || !name || name.length > 64 || !permissions.includes('mail.read')) {
            actionErrorKey.value = 'gatewayInvalidCredential'
            return false
        }
        const account = selectedAccount.value
        const generation = secretGeneration
        creating.value = true
        try {
            const response = await run(signal => api.createAppPassword({accountId: account.accountId, name, permissions}, signal))
            if (disposed) return false
            const metadata = appPasswordsFromResponse([response])[0]
            if (!metadata || metadata.accountId !== account.accountId || typeof response.password !== 'string' || response.password.length < 16 || response.password.length > 256) {
                throw new Error('Invalid gateway credential response')
            }
            appPasswords.value = [metadata, ...appPasswords.value.filter(item => item.id !== metadata.id)]
            credentialName.value = ''
            // Leaving a keep-alive page or changing mailbox also invalidates a
            // still-pending secret; late responses cannot reopen its dialog.
            if (generation !== secretGeneration) {
                createOutcomeUnknown.value = true
                return false
            }
            // Only this local dialog state may contain the credential itself.
            oneTimeSecret.value = {id: metadata.id, mailboxAddress: metadata.mailboxAddress || account.email, password: response.password}
            return true
        } catch (error) {
            if (!disposed) {
                actionErrorKey.value = gatewayErrorKey(error)
                const status = Number(error?.status) || 0
                createOutcomeUnknown.value = status === 0 || status >= 500
            }
            return false
        } finally {
            if (!disposed) creating.value = false
        }
    }

    async function revoke(credentialId) {
        if (disposed || revokingId.value || loading.value || creating.value || !ready.value) return false
        const credential = appPasswords.value.find(item => item.id === credentialId)
        if (!credential || credential.revokedAt) return false
        revokingId.value = credentialId
        actionErrorKey.value = ''
        try {
            const response = await run(signal => api.revokeAppPassword(credentialId, signal))
            if (disposed) return false
            if (response?.revoked !== true) throw new Error('Invalid revocation response')
            credential.revokedAt = new Date().toISOString()
            if (oneTimeSecret.value?.id === credentialId) clearSecret()
            return true
        } catch (error) {
            if (!disposed) actionErrorKey.value = gatewayErrorKey(error)
            return false
        } finally {
            if (!disposed) revokingId.value = ''
        }
    }

    function dispose() {
        disposed = true
        clearSecret()
        ++submissionGeneration
        submissionController?.abort()
        controllers.forEach(controller => controller.abort())
        controllers.clear()
        accounts.value = []
        appPasswords.value = []
        submissions.value = []
        credentialName.value = ''
    }

    return {
        accounts, appPasswords, visibleAppPasswords, submissions, selectedAccountId, selectedAccount,
        loading, creating, revokingId, submissionsLoading, errorKey, accountsErrorKey, actionErrorKey,
        submissionsErrorKey, createOutcomeUnknown, ready, oneTimeSecret, credentialName, requestedPermissions,
        refresh, refreshSubmissions, selectAccount, create, revoke, clearSecret, dispose,
    }
}
