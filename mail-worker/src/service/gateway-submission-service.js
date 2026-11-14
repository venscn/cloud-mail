import emailService from './email-service';
import { parseEnvelope, prepareMime, readRaw, SubmissionError, validateKey } from '../gateway-submission/validation';
import { publicSubmission, SubmissionRepository } from '../gateway-submission/repository';
import { requireGatewayAuth, mutationGuard } from '../gateway/auth';
import { GatewayError } from '../gateway/errors';
import { emailConst } from '../const/entity-const';

function safeFailure(error, attempted) {
	if (error instanceof SubmissionError || error instanceof GatewayError) return { code: error.code, retryable: error.retryable };
	if (error?.name === 'BizError') return { code: error.code === 403 ? 'SEND_FORBIDDEN' : 'SEND_REJECTED', retryable: false };
	return { code: attempted ? 'OUTCOME_UNKNOWN' : 'SUBMISSION_UNAVAILABLE', retryable: !attempted };
}

// Dependency injection is only for synthetic tests. HTTP request parameters are
// never spread into the execution hooks or trusted gateway-only send options.
export function createSubmissionService({
	send = (c, params, userId, execution) => emailService.send(c, params, userId, execution),
	storage = {
		async putObj(c, key, bytes, metadata) {
			if (!c.env.r2) throw new SubmissionError(503, 'RAW_STORAGE_UNAVAILABLE', 'Private MIME storage is unavailable.', true);
			return c.env.r2.put(key, bytes, { httpMetadata: { ...metadata, cacheControl: 'private, no-store' } });
		}
	},
	repository = c => new SubmissionRepository(c),
	authorize = c => requireGatewayAuth(c, 'mail.send')
} = {}) {
	return {
		async submit(c, principal) {
			const request = c.req.raw;
			const key = validateKey(request.headers.get('idempotency-key'));
			const envelope = parseEnvelope(request.headers.get('x-cmg-envelope'), principal);
			const bytes = await readRaw(request);
			const prepared = await prepareMime(bytes, envelope, principal);
			const repo = repository(c);
			const id = crypto.randomUUID();
			const rawKey = `private-gateway/submissions/${principal.accountId}/${id}.eml`;
			const result = {
				recipients: envelope.rcpt_to.map(address => ({ address, state: 'pending', code: 'NOT_ATTEMPTED' })),
				attempts: [], email_ids: [], retryable: false, code: null
			};
			const reserved = await repo.reserve({ id, principal, key, prepared, envelope, rawKey, result });
			if (!reserved.created) {
				// Never call the business send path on duplicate POST, including a
				// stale/crashed/unknown record. A status lookup is the only recovery.
				return publicSubmission(await repo.recoverStatus(reserved.row));
			}
			let attempted = false;
			let finalized = false;
			const updateRecipients = (addresses, state, code) => {
				for (const address of addresses) {
					const recipient = result.recipients.find(item => item.address === address.toLowerCase());
					if (!recipient) throw new SubmissionError(500, 'ENVELOPE_MISMATCH', 'Submission recipient evidence is inconsistent.');
					recipient.state = state;
					recipient.code = code;
				}
			};
			const checkAuthority = async () => {
				const fresh = await authorize(c);
				if (!fresh || String(fresh.accountId) !== String(principal.accountId) || String(fresh.userId) !== String(principal.userId) || fresh.sessionId !== principal.sessionId) {
					throw new SubmissionError(403, 'SEND_FORBIDDEN', 'The submission session is no longer authorized.');
				}
			};
			const execution = {
				kind: 'gateway-submission', id, envelope, rawBytes: bytes,
				messageId: prepared.messageId, gatewayHeaders: prepared.gatewayHeaders,
				visibleTo: prepared.visibleTo, visibleCc: prepared.visibleCc,
				imageDataList: prepared.imageDataList, html: prepared.html,
				async onAttempt(addresses, channel) {
					await checkAuthority();
					updateRecipients(addresses, 'sending', 'ATTEMPT_STARTED');
					const attempt = { channel, addresses, state: 'sending' };
					result.attempts.push(attempt);
					// Persist BEFORE any provider/internal-delivery call. Failure to
					// write this boundary prevents the call, not merely its logging.
					await repo.update(principal, id, 'sending', 'dispatching', result);
					try { await checkAuthority(); } catch (error) {
						attempt.state = 'rejected';
						updateRecipients(addresses, 'rejected', 'SEND_FORBIDDEN');
						await repo.update(principal, id, 'sending', 'rejected', result);
						throw error;
					}
					attempted = true;
				},
				async onAccepted(addresses, channel) {
					updateRecipients(addresses, 'accepted', channel === 'internal' ? 'INTERNAL_ACCEPTED' : 'CHANNEL_ACCEPTED');
					const attempt = result.attempts.findLast(item => item.channel === channel && item.state === 'sending');
					if (attempt) attempt.state = 'accepted';
					await repo.update(principal, id, 'sending', 'accepted', result);
				},
				async onRejected(addresses, code = 'CHANNEL_REJECTED', retryable = false) {
					updateRecipients(addresses, 'rejected', code);
					for (const attempt of result.attempts) {
						if (attempt.state === 'sending' && attempt.addresses.some(address => addresses.includes(address))) attempt.state = 'rejected';
					}
					result.retryable = retryable;
					await repo.update(principal, id, 'sending', 'rejected', result);
				},
				async onUnknown(addresses) {
					updateRecipients(addresses, 'unknown', 'OUTCOME_UNKNOWN');
					for (const attempt of result.attempts) {
						if (attempt.state === 'sending') attempt.state = 'unknown';
					}
					await repo.update(principal, id, 'sending', 'uncertain', result);
				},
				async onSentSaved(emailId) {
					if (!result.email_ids.includes(emailId)) result.email_ids.push(emailId);
					await repo.update(principal, id, 'sending', 'saving_sent', result);
				},
				async commitEmailStatus(emailId, accountId, status) {
					// Authorization and the visibility transition share one D1
					// transaction. Revocation during R2 I/O cannot expose a delivery.
					const guard = mutationGuard(c, principal, { operation: 'mail.send' });
					const results = await c.env.db.batch([guard.start,
						c.env.db.prepare('UPDATE email SET status=? WHERE email_id=? AND account_id=? AND status=? RETURNING email_id').bind(status, emailId, accountId, emailConst.status.GATEWAY_PENDING), guard.end]);
					// D1 meta.changes includes projection-trigger writes; RETURNING
					// identifies only the staging row directly finalized by this UPDATE.
					const committed = results[1]?.results;
					if (committed?.length !== 1 || String(committed[0].email_id) !== String(emailId)) throw new SubmissionError(503, 'SUBMISSION_STORAGE_UNAVAILABLE', 'The saved message could not be finalized.', true);
				}
			};
			try {
				// Private immutable original and its digest are persisted before any
				// outbound effects. No waitUntil/goroutine masquerades as a queue.
				await storage.putObj(c, rawKey, bytes, { contentType: 'message/rfc822' });
				await checkAuthority();
				await send(c, prepared.params, Number(principal.userId), execution);
				if (!result.recipients.every(item => item.state === 'accepted') || !result.email_ids.length) {
					throw new SubmissionError(502, 'INCOMPLETE_SUBMISSION', 'Not all recipients were accepted and saved.');
				}
				result.code = 'CHANNEL_ACCEPTED';
				result.retryable = false;
				await repo.update(principal, id, 'sent', 'complete', result);
				finalized = true;
			} catch (error) {
				const failure = safeFailure(error, attempted);
				const uncertain = result.recipients.some(item => ['sending', 'unknown'].includes(item.state)) || result.recipients.every(item => item.state === 'accepted');
				result.code = uncertain ? 'OUTCOME_UNKNOWN' : failure.code;
				result.retryable = !uncertain && !result.recipients.some(item => item.state === 'accepted') && (result.retryable || failure.retryable);
				for (const item of result.recipients) {
					if (item.state === 'sending') { item.state = 'unknown'; item.code = 'OUTCOME_UNKNOWN'; }
				}
				// Even a failed final-state write leaves the earlier durable sending
				// evidence. Never turn a persistence error into success or re-send.
				try {
					await repo.update(principal, id, uncertain ? 'unknown' : 'failed', uncertain ? 'reconcile_required' : 'complete', result);
					finalized = true;
				} catch { /* authoritative record is read below; safe 503 if unavailable */ }
			}
			const row = await repo.byId(principal, id);
			if (!row) throw new SubmissionError(503, 'SUBMISSION_STORAGE_UNAVAILABLE', 'Submission status is unavailable.', true);
			if (!finalized && row.state === 'sending') return publicSubmission(row);
			return publicSubmission(row);
		},

		async get(c, principal, id) {
			if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new SubmissionError(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.');
			const repo = repository(c);
			return publicSubmission(await repo.recoverStatus(await repo.byId(principal, id)));
		},

		async byKey(c, principal, key) {
			validateKey(key);
			const repo = repository(c);
			return publicSubmission(await repo.recoverStatus(await repo.byKey(principal, key)));
		},

		async listForWeb(c, userId, accountId) {
			const repo = repository(c);
			const rows = await repo.list(userId, accountId);
			const items = [];
			for (const row of rows) {
				const value = publicSubmission(await repo.recoverStatus(row));
				items.push({ id: value.id, accountId: String(row.account_id), state: value.state,
					createdAt: value.created_at, updatedAt: value.updated_at,
					acceptance: value.acceptance, retryable: value.retryable,
					requiresReconciliation: value.requires_reconciliation, code: value.code,
					recipients: value.recipients,
					partial: value.recipients.some(item => item.state === 'accepted') && value.recipients.some(item => item.state !== 'accepted') });
			}
			return items;
		}
	};
}

export default createSubmissionService();
