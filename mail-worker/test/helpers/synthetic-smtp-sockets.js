let factory;
export function setSocketFactory(value) { factory = value; }
export function connect(...args) {
	if (!factory) throw new Error('Synthetic SMTP socket factory was not installed; real network access is forbidden');
	return factory(...args);
}
