import { fail, notFound } from './errors.js';
import { id, name, permissions as validatePermissions, randomToken, sha256 } from './validation.js';

const SESSION_TTL = 60 * 60 * 1000;
const authFailure = () => fail(401, 'SESSION_INVALID', 'Invalid or expired credentials');
const accountSQL = `SELECT a.account_id,a.user_id,a.email AS mailbox_address,a.name,a.status AS account_status,a.is_del AS account_deleted,
 u.status AS user_status,u.is_del AS user_deleted,u.email AS user_email,u.type AS role_id,r.avail_domain,
 GROUP_CONCAT(DISTINCT CASE WHEN p.type=2 THEN p.perm_key END) AS perm_keys
 FROM account a JOIN user u ON u.user_id=a.user_id LEFT JOIN role r ON r.role_id=u.type
 LEFT JOIN role_perm rp ON rp.role_id=r.role_id LEFT JOIN perm p ON p.perm_id=rp.perm_id`;
const configuredDomains = c => Array.isArray(c.env.domain) ? c.env.domain.map(value => String(value).replace(/^@/, '').trim().toLowerCase()).filter(Boolean) : [];
function domainAllowed(c, row) {
	const domain = row.mailbox_address.split('@')[1]?.toLowerCase();
	if (!domain || !configuredDomains(c).includes(domain)) return false;
	if (row.user_email === c.env.admin) return true;
	if (row.avail_domain === null || row.avail_domain === undefined) return false;
	const domains = row.avail_domain.replace(/ /g, '').toLowerCase().split(',').filter(Boolean);
	return !domains.length || domains.includes(domain);
}
function usableAccount(c, row) {
	return row && row.account_status === 0 && row.account_deleted === 0 && row.user_status === 0 && row.user_deleted === 0 && domainAllowed(c, row);
}
function allowed(c, row, requested) {
	const keys = (row.perm_keys || '').split(',');
	const admin = row.user_email === c.env.admin;
	if (!admin && !keys.includes('account:query')) return [];
	return requested.filter(operation => operation !== 'mail.send' || admin || keys.includes('email:send'));
}
// The three bindings are expected mailbox address, configured domains JSON, admin.
// Reused inside writes rather than trusting a pre-R2 authorization check.
const currentPolicySQL = (send = false, deletion = false) => `AND a.status=0 AND a.is_del=0 AND u.status=0 AND u.is_del=0
 AND a.email=? COLLATE NOCASE
 AND lower(substr(a.email,instr(a.email,'@')+1)) IN(SELECT value FROM json_each(?))
 AND (u.email=? OR (r.role_id IS NOT NULL AND r.avail_domain IS NOT NULL
 AND (replace(r.avail_domain,' ','')='' OR instr(','||lower(replace(r.avail_domain,' ',''))||',',','||lower(substr(a.email,instr(a.email,'@')+1))||',')>0)
 AND EXISTS(SELECT 1 FROM role_perm rp JOIN perm p ON p.perm_id=rp.perm_id WHERE rp.role_id=u.type AND p.perm_key='account:query' AND p.type=2)
 ${send ? "AND EXISTS(SELECT 1 FROM role_perm rp JOIN perm p ON p.perm_id=rp.perm_id WHERE rp.role_id=u.type AND p.perm_key='email:send' AND p.type=2)" : ''}
 ${deletion ? "AND EXISTS(SELECT 1 FROM role_perm rp JOIN perm p ON p.perm_id=rp.perm_id WHERE rp.role_id=u.type AND p.perm_key='email:delete' AND p.type=2)" : ''}))`;
const policyBindings = (c, address) => [address, JSON.stringify(configuredDomains(c)), c.env.admin || ''];
export function requireDeletionPermission(principal) {
	if (!principal.isAdmin && !principal.permKeys.includes('email:delete')) fail(403, 'DELETE_FORBIDDEN', 'Your role does not allow message deletion');
}
export async function ensureGatewaySchema(c) {
	const row = await c.env.db.prepare("SELECT value FROM gateway_meta WHERE key='schema_version'").first();
	if (row?.value !== '1') fail(503, 'GATEWAY_NOT_INITIALIZED', 'Gateway database migration is required', true);
}
async function loginRateLimit(c, address) {
	const now = Date.now(), window = Math.floor(now / 300000);
	const ip = c.req.header('CF-Connecting-IP') || 'unknown';
	const keys = [await sha256(`ip:${ip}:${window}`), await sha256(`account:${address}:${window}`)];
	const statements = [c.env.db.prepare('DELETE FROM gateway_rate_limits WHERE key IN(SELECT key FROM gateway_rate_limits WHERE expires_at<? LIMIT 500)').bind(now)];
	for (const key of keys) statements.push(c.env.db.prepare(`INSERT INTO gateway_rate_limits(key,attempts,expires_at)
 SELECT ?,1,? WHERE (SELECT COUNT(*) FROM gateway_rate_limits)<10000
 ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts`).bind(key, (window + 1) * 300000));
	const result = await c.env.db.batch(statements);
	if (!result[1].results?.length || !result[2].results?.length || result[1].results[0].attempts > 60 || result[2].results[0].attempts > 15) fail(429, 'RATE_LIMITED', 'Too many authentication attempts; try later', true);
}
export async function createSession(c, value) {
	await ensureGatewaySchema(c);
	if (typeof value.mailbox_address !== 'string' || value.mailbox_address.length > 254 || !/^[^\s<>@]+@[^\s<>@]+$/.test(value.mailbox_address) || typeof value.app_password !== 'string' || value.app_password.length > 200) authFailure();
	const address = value.mailbox_address.toLowerCase();
	await loginRateLimit(c, address);
	const match = /^cmg_([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(value.app_password);
	const digest = await sha256(`cmg-app\0${match?.[1] || ''}\0${match?.[2] || value.app_password}`);
	const credential = await c.env.db.prepare('SELECT * FROM gateway_credentials WHERE id=? AND password_hash=? AND revoked_at IS NULL').bind(match?.[1] || '', digest).first();
	if (!credential) authFailure();
	const row = await c.env.db.prepare(`${accountSQL} WHERE a.account_id=? AND a.user_id=? AND lower(a.email)=? GROUP BY a.account_id`).bind(credential.account_id, credential.user_id, address).first();
	if (!usableAccount(c, row)) authFailure();
	const operations = allowed(c, row, JSON.parse(credential.permissions));
	if (!operations.length) fail(403, 'FORBIDDEN', 'Your role no longer permits mailbox access');
	const token = `cmgs_${randomToken()}`, sessionId = crypto.randomUUID(), now = Date.now(), expires = now + SESSION_TTL;
	await c.env.db.batch([
		c.env.db.prepare('DELETE FROM gateway_sessions WHERE id IN(SELECT id FROM gateway_sessions WHERE expires_at<? OR revoked_at IS NOT NULL LIMIT 500)').bind(now),
		c.env.db.prepare('DELETE FROM gateway_sessions WHERE id IN(SELECT id FROM gateway_sessions WHERE credential_id=? ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 19)').bind(credential.id),
		c.env.db.prepare(`INSERT INTO gateway_sessions(id,token_hash,credential_id,user_id,account_id,created_at,expires_at)
 SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM gateway_credentials k JOIN account a ON a.account_id=k.account_id JOIN user u ON u.user_id=k.user_id LEFT JOIN role r ON r.role_id=u.type
 WHERE k.id=? AND k.password_hash=? AND k.revoked_at IS NULL AND a.user_id=k.user_id ${currentPolicySQL(operations[0] === 'mail.send')})`).bind(sessionId, await sha256(token), credential.id, credential.user_id, credential.account_id, now, expires, credential.id, digest, ...policyBindings(c, row.mailbox_address)),
		c.env.db.prepare('UPDATE gateway_credentials SET last_used_at=? WHERE id=?').bind(now, credential.id)
	]);
	let principal;
	try {
		principal = await requireGatewayAuth({ env: c.env, req: { header: key => key.toLowerCase() === 'authorization' ? `Bearer ${token}` : c.req.header(key) } }, operations[0]);
		if (principal.mailboxAddress.toLowerCase() !== address) authFailure();
	} catch (error) {
		await c.env.db.prepare('DELETE FROM gateway_sessions WHERE id=?').bind(sessionId).run();
		throw error;
	}
	return { session_token: token, token_type: 'Bearer', expires_at: new Date(expires).toISOString(), account_id: principal.accountId, mailbox_address: principal.mailboxAddress, allowed_operations: principal.permissions };
}
export async function requireGatewayAuth(c, operation = 'mail.read') {
	await ensureGatewaySchema(c);
	const header = c.req.header('Authorization') || '';
	if (!/^Bearer cmgs_[A-Za-z0-9_-]{43}$/.test(header)) authFailure();
	const session = await c.env.db.prepare(`SELECT s.*,k.permissions,k.revoked_at AS credential_revoked FROM gateway_sessions s
 JOIN gateway_credentials k ON k.id=s.credential_id AND k.account_id=s.account_id AND k.user_id=s.user_id
 WHERE s.token_hash=? AND s.expires_at>? AND s.revoked_at IS NULL AND k.revoked_at IS NULL`).bind(await sha256(header.slice(7)), Date.now()).first();
	if (!session) authFailure();
	const row = await c.env.db.prepare(`${accountSQL} WHERE a.account_id=? AND a.user_id=? GROUP BY a.account_id`).bind(session.account_id, session.user_id).first();
	if (!usableAccount(c, row)) authFailure();
	const operations = allowed(c, row, JSON.parse(session.permissions));
	if (operation && !operations.includes(operation)) fail(403, 'FORBIDDEN', 'The requested operation is not allowed');
	return { accountId: String(row.account_id), userId: String(row.user_id), mailboxAddress: row.mailbox_address,
		permissions: operations, credentialId: session.credential_id, sessionId: session.id,
		permKeys: (row.perm_keys || '').split(','), isAdmin: row.user_email === c.env.admin };
}
export function mutationGuard(c, principal, { operation = 'mail.write', deletion = false, revision = null, mailboxId = null, allocations = 0 } = {}) {
	const key = crypto.randomUUID();
	const sql = `INSERT INTO gateway_write_guard(id,authorized,revision_ok,capacity_ok)
 SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM gateway_sessions s
 JOIN gateway_credentials k ON k.id=s.credential_id AND k.account_id=s.account_id AND k.user_id=s.user_id
 JOIN account a ON a.account_id=s.account_id AND a.user_id=s.user_id JOIN user u ON u.user_id=s.user_id LEFT JOIN role r ON r.role_id=u.type
 WHERE s.id=? AND s.account_id=? AND s.user_id=? AND s.expires_at>? AND s.revoked_at IS NULL AND k.revoked_at IS NULL
 AND EXISTS(SELECT 1 FROM json_each(k.permissions) WHERE value=?) ${currentPolicySQL(operation === 'mail.send', deletion)}) THEN 1 ELSE 0 END,
 CASE WHEN ? IS NULL OR EXISTS(SELECT 1 FROM gateway_accounts WHERE account_id=? AND revision=?) THEN 1 ELSE 0 END,
 CASE WHEN ?=0 OR EXISTS(SELECT 1 FROM gateway_mailboxes WHERE id=? AND account_id=? AND uid_next+?<=4294967295) THEN 1 ELSE 0 END`;
	return { start: c.env.db.prepare(sql).bind(key, principal.sessionId, principal.accountId, principal.userId, Date.now(), operation, ...policyBindings(c, principal.mailboxAddress), revision, principal.accountId, revision, allocations, mailboxId, principal.accountId, allocations),
		end: c.env.db.prepare('DELETE FROM gateway_write_guard WHERE id=?').bind(key) };
}
export async function logout(c, principal) {
	await c.env.db.prepare('UPDATE gateway_sessions SET revoked_at=? WHERE id=?').bind(Date.now(), principal.sessionId).run();
	return { revoked: true };
}
async function webUser(c, userId) {
	const row = await c.env.db.prepare('SELECT u.user_id,u.email,u.status,u.is_del,u.type,r.role_id FROM user u LEFT JOIN role r ON r.role_id=u.type WHERE u.user_id=?').bind(userId).first();
	if (!row || row.status !== 0 || row.is_del !== 0) authFailure();
	return row;
}
export async function webAccounts(c, userId) {
	await ensureGatewaySchema(c);
	const user = await webUser(c, userId);
	if (user.email !== c.env.admin && !await c.env.db.prepare(`SELECT 1 FROM role_perm rp JOIN perm p ON p.perm_id=rp.perm_id WHERE rp.role_id=? AND p.perm_key='account:query' AND p.type=2`).bind(user.type).first()) fail(403, 'FORBIDDEN', 'Your role does not allow mailbox access');
	const rows = (await c.env.db.prepare(`${accountSQL} WHERE a.user_id=? GROUP BY a.account_id ORDER BY a.account_id LIMIT 500`).bind(userId).all()).results;
	return rows.filter(row => usableAccount(c, row) && allowed(c, row, ['mail.read']).length).map(row => ({ accountId: String(row.account_id), email: row.mailbox_address, name: row.name }));
}
function credentialJSON(row) {
	return { id: row.id, accountId: String(row.account_id), mailboxAddress: row.mailbox_address, name: row.name,
		createdAt: new Date(row.created_at).toISOString(), lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
		revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(), permissions: JSON.parse(row.permissions) };
}
export async function listCredentials(c, userId) {
	await ensureGatewaySchema(c);
	await webUser(c, userId);
	const rows = await c.env.db.prepare(`SELECT k.*,a.email AS mailbox_address FROM gateway_credentials k JOIN account a ON a.account_id=k.account_id
 WHERE k.user_id=? AND a.user_id=? ORDER BY k.created_at DESC LIMIT 100`).bind(userId, userId).all();
	return rows.results.map(credentialJSON);
}
export async function createCredential(c, userId, value) {
	await ensureGatewaySchema(c);
	await webUser(c, userId);
	const accountId = id(String(value.accountId)), label = name(value.name, 64), operations = validatePermissions(value.permissions);
	const account = await c.env.db.prepare(`${accountSQL} WHERE a.account_id=? AND a.user_id=? GROUP BY a.account_id`).bind(accountId, userId).first();
	if (!account) notFound();
	if (!usableAccount(c, account) || allowed(c, account, operations).length !== operations.length) fail(403, 'FORBIDDEN', 'Your role does not allow these mailbox permissions');
	const credentialId = crypto.randomUUID().replace(/-/g, ''), secret = randomToken(), now = Date.now();
	const result = await c.env.db.prepare(`INSERT INTO gateway_credentials(id,user_id,account_id,name,password_hash,permissions,created_at)
 SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM gateway_credentials WHERE user_id=? AND revoked_at IS NULL)<20
 AND EXISTS(SELECT 1 FROM account a JOIN user u ON u.user_id=a.user_id LEFT JOIN role r ON r.role_id=u.type WHERE a.account_id=? AND a.user_id=? ${currentPolicySQL(operations.includes('mail.send'))})`).bind(credentialId, userId, accountId, label, await sha256(`cmg-app\0${credentialId}\0${secret}`), JSON.stringify(operations), now, userId, accountId, userId, ...policyBindings(c, account.mailbox_address)).run();
	if (!result.meta.changes) fail(409, 'CREDENTIAL_LIMIT', 'Application password limit reached or account authorization changed');
	return { ...credentialJSON({ id: credentialId, account_id: accountId, mailbox_address: account.mailbox_address, name: label, permissions: JSON.stringify(operations), created_at: now, last_used_at: null, revoked_at: null }), password: `cmg_${credentialId}.${secret}` };
}
export async function revokeCredential(c, userId, credentialId) {
	await ensureGatewaySchema(c);
	await webUser(c, userId);
	if (!/^[a-f0-9]{32}$/.test(credentialId)) notFound();
	const row = await c.env.db.prepare('SELECT id FROM gateway_credentials WHERE id=? AND user_id=?').bind(credentialId, userId).first();
	if (!row) notFound();
	await c.env.db.batch([
		c.env.db.prepare('UPDATE gateway_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?').bind(Date.now(), credentialId, userId),
		c.env.db.prepare('UPDATE gateway_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE credential_id=? AND user_id=?').bind(Date.now(), credentialId, userId)
	]);
	return { revoked: true };
}
