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
    const hostname = normalizeGatewayHostname(settings?.gatewayHostname)
    const enabled = settings?.gatewayEnabled === 1 && !!hostname
    return {enabled, hostname: enabled ? hostname : ''}
}

export function gatewaySettingsPatch(enabled, hostname) {
    if (enabled !== 0 && enabled !== 1) return null
    const normalized = normalizeGatewayHostname(hostname)
    if (normalized === null || (enabled === 1 && !normalized)) return null
    return {gatewayEnabled: enabled, gatewayHostname: normalized}
}
