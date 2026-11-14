// The sole business dependency replaced by this integration suite. No external
// provider is contacted. Auth, MIME validation, durable submission state, reconstruction,
// mutation guards and IMAP mailbox materialization remain production code.
import { createHash } from 'node:crypto';
import { recordSentCopy } from '../../src/gateway/raw.js';
import { emailConst } from '../../src/const/entity-const.js';
import attService from '../../src/service/att-service.js';

export async function syntheticSend(c, params, userId, execution) {
	if (execution?.kind !== 'gateway-submission') throw new Error('Expected real submission execution hooks');
	const recipients = [...execution.envelope.rcpt_to];
	await execution.onAttempt(recipients, 'synthetic');
	const row = c.env.db.sqlite.prepare('SELECT state,phase FROM gateway_submissions WHERE id=?').get(execution.id);
	const payloadHash = createHash('sha256').update(execution.rawBytes).digest('hex');
	c.env.integration.calls.push({ recipients, payloadHash, stateAtDispatch: row?.state, phaseAtDispatch: row?.phase });
	if (c.env.integration.mode === 'unknown') throw new Error('Synthetic ambiguous provider timeout');
	await execution.onAccepted(recipients, 'synthetic');
	const saved = c.env.db.sqlite.prepare(`INSERT INTO email(account_id,user_id,type,status,send_email,to_email,subject,text,content,message_id,recipient,cc,bcc)
		VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?)`).run(Number(params.accountId), Number(userId), emailConst.status.GATEWAY_PENDING, execution.envelope.mail_from,
		recipients[0], params.subject || '', params.text || '', params.content || '', execution.messageId,
		JSON.stringify(execution.visibleTo), JSON.stringify(execution.visibleCc), JSON.stringify(recipients.filter(address => !execution.visibleTo.includes(address) && !execution.visibleCc.includes(address))));
	const emailId = Number(saved.lastInsertRowid);
	if (params.attachments?.length) await attService.saveSendAtt(c, params.attachments, userId, params.accountId, emailId);
	// Mirror saveSentEmail's gateway-only persistence boundary with the actual
	// hash-only Sent ledger and existing attachment service, never a raw MIME put.
	await recordSentCopy(c, { emailId, accountId: String(params.accountId), bytes: execution.rawBytes,
		envelope: execution.envelope, submissionId: execution.id });
	await execution.onSentSaved(emailId);
	await c.env.integration.beforeSentCommit?.(c, emailId);
	await execution.commitEmailStatus(emailId, params.accountId, emailConst.status.RECEIVE);
	return { emailId };
}
