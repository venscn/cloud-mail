// Public display configuration only; never infer readiness from the website URL.
export function normalizeGatewayHostname(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null
    const hostname = value.trim().toLowerCase()
    if (!hostname) return ''
    const labels = hostname.split('.')
    if (hostname.length > 253 || labels.length < 2 || !/[a-z]/.test(labels.at(-1))
        || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
    return hostname
}

export function gatewayDisplayConfig(settings) {
    // Only the independently configured endpoints are accepted; no shared-host fallback.
    const imapHostname = normalizeGatewayHostname(settings?.gatewayImapHostname)
    const smtpHostname = normalizeGatewayHostname(settings?.gatewaySmtpHostname)
    const enabled = settings?.gatewayEnabled === 1 && !!imapHostname && !!smtpHostname
    return {enabled, imapHostname: enabled ? imapHostname : '', smtpHostname: enabled ? smtpHostname : ''}
}

export function gatewaySettingsPatch(enabled, imapHostname, smtpHostname) {
    if (enabled !== 0 && enabled !== 1) return null
    const imap = normalizeGatewayHostname(imapHostname)
    const smtp = normalizeGatewayHostname(smtpHostname)
    if (imap === null || smtp === null || (enabled === 1 && (!imap || !smtp))) return null
    return {gatewayEnabled: enabled, gatewayImapHostname: imap, gatewaySmtpHostname: smtp}
}
