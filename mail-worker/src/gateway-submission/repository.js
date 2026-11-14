import { SubmissionError } from './validation';

const STALE_SENDING_MS = 10 * 60 * 1000;

export class SubmissionRepository {
	constructor(c) { this.db = c.env.db; }

	async reserve({ id, principal, key, prepared, envelope, rawKey, result }) {
		const now = new Date().toISOString();
		const inserted = await this.db.prepare(`INSERT INTO gateway_submissions
			(id, account_id, user_id, idempotency_key, request_hash, payload_hash, envelope_json, raw_key, message_id, state, phase, result_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', 'preparing', ?, ?, ?)
			ON CONFLICT(account_id, idempotency_key) DO NOTHING`)
			.bind(id, principal.accountId, principal.userId, key, prepared.requestHash, prepared.payloadHash, JSON.stringify(envelope), rawKey, prepared.messageId, JSON.stringify(result), now, now).run();
		const row = await this.byKey(principal, key);
		if (!row) throw new SubmissionError(503, 'SUBMISSION_STORAGE_UNAVAILABLE', 'Submission persistence is unavailable.', true);
		if (row.request_hash !== prepared.requestHash) throw new SubmissionError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for another request.');
		return { row, created: inserted.meta.changes === 1 };
	}

	byKey(principal, key) {
		return this.db.prepare('SELECT * FROM gateway_submissions WHERE account_id = ? AND user_id = ? AND idempotency_key = ?')
			.bind(principal.accountId, principal.userId, key).first();
	}

	byId(principal, id) {
		return this.db.prepare('SELECT * FROM gateway_submissions WHERE account_id = ? AND user_id = ? AND id = ?')
			.bind(principal.accountId, principal.userId, id).first();
	}

	async update(principal, id, state, phase, result) {
		const now = new Date().toISOString();
		// There is exactly one executor: only the invocation that inserted the
		// record may call this. Duplicate POST and all GETs never perform sends.
		const changed = await this.db.prepare(`UPDATE gateway_submissions SET state = ?, phase = ?, result_json = ?, updated_at = ?
			WHERE id = ? AND account_id = ? AND user_id = ? AND state IN ('sending', 'unknown')`)
			.bind(state, phase, JSON.stringify(result), now, id, principal.accountId, principal.userId).run();
		if (changed.meta.changes !== 1) throw new SubmissionError(503, 'SUBMISSION_STORAGE_UNAVAILABLE', 'Submission persistence is unavailable.', true);
		return now;
	}

	async recoverStatus(row) {
		if (row?.state === 'sending' && Date.now() - Date.parse(row.updated_at) >= STALE_SENDING_MS) {
			// This is reconciliation, NOT queue recovery. A crashed sender might
			// have crossed an external acceptance boundary, so never execute it.
			const now = new Date().toISOString();
			await this.db.prepare(`UPDATE gateway_submissions SET state = 'unknown', phase = 'interrupted', updated_at = ?
				WHERE id = ? AND state = 'sending' AND updated_at = ?`).bind(now, row.id, row.updated_at).run();
			return await this.db.prepare('SELECT * FROM gateway_submissions WHERE id = ?').bind(row.id).first();
		}
		return row;
	}

	async list(userId, accountId) {
		// Ownership is joined again: an account transfer must hide the previous
		// owner's submission metadata rather than trusting old saved user_id.
		const params = [userId, userId];
		let filter = '';
		if (accountId !== undefined && accountId !== null && accountId !== '') {
			if (!/^(?:0|[1-9]\d*)$/.test(String(accountId))) throw new SubmissionError(400, 'INVALID_ACCOUNT', 'The account identifier is invalid.');
			filter = ' AND s.account_id = ?';
			params.push(accountId);
		}
		const { results } = await this.db.prepare(`SELECT s.* FROM gateway_submissions s
			JOIN account a ON a.account_id = s.account_id
			WHERE s.user_id = ? AND a.user_id = ? AND a.is_del = 0${filter}
			ORDER BY s.created_at DESC, s.id DESC LIMIT 50`).bind(...params).all();
		return results;
	}
}

export function publicSubmission(row) {
	if (!row) throw new SubmissionError(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.');
	let result;
	try { result = JSON.parse(row.result_json); } catch { result = {}; }
	const recipients = Array.isArray(result.recipients) ? result.recipients.slice(0, 50).map(item => ({
		address: String(item.address || ''), state: String(item.state || 'unknown'), code: String(item.code || 'UNKNOWN')
	})) : [];
	return {
		id: row.id, state: row.state, message_id: row.message_id,
		created_at: row.created_at, updated_at: row.updated_at,
		// "sent" means all delivery channels accepted, not final delivery.
		acceptance: row.state === 'sent' ? 'channel_accepted' : null,
		retryable: row.state === 'failed' && result.retryable === true,
		requires_reconciliation: row.state === 'unknown' || row.state === 'sending',
		code: row.state === 'unknown' ? 'OUTCOME_UNKNOWN' : (result.code || null),
		recipients
	};
}
