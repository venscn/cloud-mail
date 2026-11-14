// This client deliberately uses the existing website HTTP instance (JWT, not a
// gateway Bearer session). Keep failures free of Axios config/response objects:
// a successful creation response contains a one-time credential.
export class GatewayManagementError extends Error {
    constructor(status = 0) {
        super('Gateway management request failed')
        this.name = 'GatewayManagementError'
        this.status = Number.isInteger(status) ? status : 0
    }
}

export function normalizeGatewayResponse(body, _headers, status) {
    // Accept HTTP errors in the success interceptor so its legacy HTTP-403 page
    // reload is not invoked. The noMsg Result path below still rejects them.
    if (status < 200 || status >= 300) return {code: status || 503}
    let result
    try {
        result = typeof body === 'string' ? JSON.parse(body) : body
    } catch {
        return {code: 502}
    }
    if (!result || typeof result !== 'object' || !Number.isInteger(result.code)) return {code: 502}
    if (result.code !== 200) return {code: result.code >= 400 && result.code <= 599 ? result.code : 502}
    return {code: 200, data: result.data}
}

export function gatewayErrorStatus(error) {
    if (error?.code === 'ERR_CANCELED' || error?.name === 'AbortError') return -1
    return Number(error?.status || error?.code || error?.response?.status) || 0
}

export function createGatewayManagementApi(http) {
    async function request(method, path, {data, params, signal} = {}) {
        try {
            return await http.request({
                method,
                // The website's existing baseURL already contains /api.
                url: `/gateway${path}`,
                data,
                params,
                signal,
                timeout: 20000,
                noMsg: true,
                headers: {'Cache-Control': 'no-store'},
                validateStatus: () => true,
                transformResponse: [normalizeGatewayResponse],
            })
        } catch (error) {
            // Never retain/log the original error, Authorization or password.
            throw new GatewayManagementError(gatewayErrorStatus(error))
        }
    }

    return {
        accounts: signal => request('get', '/accounts', {signal}),
        appPasswords: signal => request('get', '/app-passwords', {signal}),
        createAppPassword: (data, signal) => request('post', '/app-passwords', {data, signal}),
        revokeAppPassword: (id, signal) => request('delete', `/app-passwords/${encodeURIComponent(id)}`, {signal}),
        submissions: (accountId, signal) => request('get', '/submissions', {params: {accountId}, signal}),
    }
}
