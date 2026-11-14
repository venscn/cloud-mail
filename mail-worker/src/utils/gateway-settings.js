import BizError from '../error/biz-error';

// Display configuration only. Never gate protocol auth, delivery or credentials here.
export function normalizeGatewayHostname(value) {
	if (typeof value !== 'string' || /[^\x20-\x7e]/.test(value)) {
		throw new BizError('Gateway hostname must be an ASCII DNS hostname');
	}
	const hostname = value.trim().toLowerCase();
	if (!hostname) return '';
	const labels = hostname.split('.');
	if (hostname.length > 253 || labels.length < 2
		|| labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
		|| !/[a-z]/.test(labels.at(-1))) {
		throw new BizError('Gateway hostname must be a DNS hostname without URL, path or port');
	}
	return hostname;
}

// Old/partial/invalid KV snapshots must not reveal a configured feature by accident.
export function gatewayDisplayConfig(value) {
	let gatewayHostname = '';
	try { gatewayHostname = normalizeGatewayHostname(value.gatewayHostname); } catch { /* fail closed */ }
	return {
		gatewayEnabled: value.gatewayEnabled === 1 && gatewayHostname ? 1 : 0,
		gatewayHostname
	};
}

export function gatewaySettingsPatch(current, params) {
	const patch = {};
	if (params.gatewayEnabled !== undefined) {
		if (params.gatewayEnabled !== 0 && params.gatewayEnabled !== 1) {
			throw new BizError('gatewayEnabled must be 0 or 1');
		}
		patch.gatewayEnabled = params.gatewayEnabled;
	}
	if (params.gatewayHostname !== undefined) {
		patch.gatewayHostname = normalizeGatewayHostname(params.gatewayHostname);
	}
	if (Object.keys(patch).length) {
		const next = { ...gatewayDisplayConfig(current), ...patch };
		if (next.gatewayEnabled === 1 && !next.gatewayHostname) {
			throw new BizError('A valid gateway hostname is required when enabled');
		}
	}
	return patch;
}
