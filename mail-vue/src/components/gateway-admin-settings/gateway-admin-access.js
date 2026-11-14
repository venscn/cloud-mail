// Match the existing system-settings route permission. Unknown roles fail closed.
export function canManageGatewaySettings(user) {
    const keys = user?.permKeys
    return Array.isArray(keys) && (keys.includes('*') || keys.includes('setting:query'))
}
