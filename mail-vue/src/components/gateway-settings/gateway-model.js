import {gatewayErrorStatus} from '../../request/gateway-client.js'

export const GATEWAY_PERMISSIONS = ['mail.read', 'mail.write', 'mail.send']
const STATES = ['queued', 'sending', 'sent', 'failed', 'unknown']
const RECIPIENT_STATES = ['pending', 'sending', 'accepted', 'rejected', 'unknown']
const text = (value, max = 256) => typeof value === 'string' ? value.slice(0, max) : ''
const id = value => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 128) : ''

export function accountsFromResponse(value) {
    if (!Array.isArray(value)) throw new Error('Invalid gateway account response')
    return value.map(account => ({
        accountId: id(account.accountId), email: text(account.email), name: text(account.name),
    })).filter(account => account.accountId && account.email)
}

// Never spread a server object into reactive state: even a malformed list must
// not cause an application password, MIME or internal error to be retained.
export function appPasswordsFromResponse(value) {
    if (!Array.isArray(value)) throw new Error('Invalid gateway credential response')
    return value.map(credential => ({
        id: id(credential.id),
        accountId: id(credential.accountId),
        mailboxAddress: text(credential.mailboxAddress),
        name: text(credential.name, 64),
        createdAt: text(credential.createdAt, 40),
        lastUsedAt: text(credential.lastUsedAt, 40),
        revokedAt: text(credential.revokedAt, 40),
        permissions: Array.isArray(credential.permissions)
            ? GATEWAY_PERMISSIONS.filter(permission => credential.permissions.includes(permission)) : [],
    })).filter(credential => credential.id)
}

export function submissionsFromResponse(value, accountId) {
    if (!Array.isArray(value)) throw new Error('Invalid gateway submission response')
    return value.filter(submission => submission && id(submission.accountId) === String(accountId)).slice(0, 50).map(submission => {
        const recipients = Array.isArray(submission.recipients) ? submission.recipients.filter(Boolean).slice(0, 100).map(recipient => ({
            address: text(recipient.address),
            state: RECIPIENT_STATES.includes(recipient.state) ? recipient.state : 'unknown',
        })) : []
        const partial = submission.partial === true || (recipients.some(recipient => recipient.state === 'accepted') && recipients.some(recipient => recipient.state !== 'accepted'))
        let state = STATES.includes(submission.state) ? submission.state : 'unknown'
        // A contradictory partial result must never look like complete success.
        if (state === 'sent' && (partial || recipients.some(recipient => recipient.state !== 'accepted'))) state = 'unknown'
        return {
            id: id(submission.id), accountId: id(submission.accountId), state,
            createdAt: text(submission.createdAt, 40), updatedAt: text(submission.updatedAt, 40),
            recipients, partial,
        }
    })
}

export function gatewayErrorKey(error) {
    const status = gatewayErrorStatus(error)
    if (status === -1) return ''
    if (status === 401) return 'gatewaySignInRequired'
    if (status === 403) return 'gatewayForbidden'
    if (status === 429) return 'gatewayRateLimited'
    if (status === 0 || status === 404 || status >= 500) return 'gatewayUnavailable'
    return 'gatewayRequestFailed'
}

export function submissionPresentation(state) {
    const knownState = STATES.includes(state) ? state : 'unknown'
    return {
        label: `gatewayState_${knownState}`,
        description: `gatewayStateHint_${knownState}`,
        type: {queued: 'info', sending: 'warning', sent: 'success', failed: 'danger', unknown: 'warning'}[knownState],
    }
}
