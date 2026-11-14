import http from '@/axios/index.js';

export function settingSet(setting) {
    return http.put('/setting/set', setting)
}

// Bodyless request: only the server can choose the saved target and fixed port.
export function gatewayConnectivity(protocol, signal) {
    if (!['imap','smtp'].includes(protocol)) return Promise.reject(new Error('INVALID_REQUEST'))
    return http.post(`/setting/gatewayConnectivity/${protocol}`, undefined, {
        signal, timeout: 15000, noMsg: true, validateStatus: () => true
    })
}

export function settingQuery() {
    return http.get('/setting/query')
}

export function websiteConfig() {
    return http.get('/setting/websiteConfig')
}

export function setBackground(background) {
    return http.put('/setting/setBackground',{background})
}

export function deleteBackground() {
    return http.delete('/setting/deleteBackground')
}

export function setBlackList(params) {
    return http.put('/setting/setBlacklist', params)
}