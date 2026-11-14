export class GatewayError extends Error {
	constructor(status, code, message, retryable = false) {
		super(message);
		this.name = 'GatewayError';
		this.status = status;
		this.code = code;
		this.retryable = retryable;
	}
}
export const fail = (status, code, message, retryable = false) => { throw new GatewayError(status, code, message, retryable); };
export const notFound = () => fail(404, 'NOT_FOUND', 'Resource not found');

export function safeGatewayError(err) {
	if (err instanceof GatewayError) return err;
	// Submission service also uses this deliberately small, safe error contract.
	if (Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 && /^[A-Z][A-Z0-9_]{0,63}$/.test(err.code || '')) {
		return new GatewayError(err.status, err.code, 'The operation could not be completed', err.retryable === true);
	}
	const text = String(err?.message || '');
	if (/gateway_authorized/.test(text)) return new GatewayError(401, 'SESSION_INVALID', 'Session is no longer authorized');
	if (/gateway_revision/.test(text)) return new GatewayError(409, 'CONCURRENT_MODIFICATION', 'Mailbox changed; retry the operation', true);
	if (/gateway_capacity|gateway_uid_exhausted/.test(text)) return new GatewayError(409, 'UID_EXHAUSTED', 'Mailbox UID capacity is exhausted');
	if (/gateway_uid_conflict/.test(text)) return new GatewayError(409, 'CONCURRENT_MODIFICATION', 'Mailbox changed; retry the operation', true);
	if (/no such (?:table|column).*gateway_|gateway_.*no such (?:table|column)/i.test(text)) return new GatewayError(503, 'GATEWAY_NOT_INITIALIZED', 'Gateway database migration is required', true);
	if (/UNIQUE constraint failed: gateway_mailboxes/.test(text)) return new GatewayError(409, 'MAILBOX_EXISTS', 'A mailbox with that name already exists');
	if (/UNIQUE constraint failed: gateway_appends/.test(text)) return new GatewayError(409, 'CONCURRENT_MODIFICATION', 'Retry with the same idempotency key', true);
	return new GatewayError(503, 'BACKEND_UNAVAILABLE', 'Mail service is temporarily unavailable', true);
}

export function errorResponse(c, err) {
	const safe = safeGatewayError(err);
	if (safe.status === 429 || ['BACKFILL_IN_PROGRESS', 'RAW_PREPARING'].includes(safe.code)) c.header('Retry-After', '2');
	c.header('Cache-Control', 'no-store');
	return c.json({ error: { code: safe.code, message: safe.message, retryable: safe.retryable, request_id: c.get('requestId') || crypto.randomUUID() } }, safe.status);
}
