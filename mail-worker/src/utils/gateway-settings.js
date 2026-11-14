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

// Missing/empty/invalid independent hosts fail closed. No old-host fallback.
export function gatewayDisplayConfig(value) {
	const safeHostname = value => {
		try { return normalizeGatewayHostname(value); } catch { return ''; }
	};
	const gatewayImapHostname = safeHostname(value.gatewayImapHostname);
	const gatewaySmtpHostname = safeHostname(value.gatewaySmtpHostname);
	return {
		gatewayEnabled: value.gatewayEnabled === 1 && gatewayImapHostname && gatewaySmtpHostname ? 1 : 0,
		gatewayImapHostname,
		gatewaySmtpHostname
	};
}

export function gatewaySettingsPatch(current, params) {
	if (Object.hasOwn(params, 'gatewayHostname')) {
		throw new BizError('gatewayHostname is no longer supported; configure IMAP and SMTP hostnames separately');
	}
	const patch = {};
	if (params.gatewayEnabled !== undefined) {
		if (params.gatewayEnabled !== 0 && params.gatewayEnabled !== 1) {
			throw new BizError('gatewayEnabled must be 0 or 1');
		}
		patch.gatewayEnabled = params.gatewayEnabled;
	}
	for (const key of ['gatewayImapHostname', 'gatewaySmtpHostname']) {
		if (params[key] !== undefined) patch[key] = normalizeGatewayHostname(params[key]);
	}
	if (Object.keys(patch).length) {
		// Validate stored state, not the fail-closed display switch.
		const next = { ...current, ...patch };
		if (next.gatewayEnabled === 1 && gatewayDisplayConfig(next).gatewayEnabled !== 1) {
			throw new BizError('Valid IMAP and SMTP gateway hostnames are required when enabled');
		}
	}
	return patch;
}
