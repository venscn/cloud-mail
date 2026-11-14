// Canonical, repeatable D1 migration. The checked-in SQL mirror is verified in tests.
// No production config, secret, network binding or deployment is used by this module.
export const MAX_UID = 4294967295;
export const DEFAULT_MAILBOXES = [
	['INBOX', '\\Inbox'], ['Sent', '\\Sent'], ['Drafts', '\\Drafts'],
	['Trash', '\\Trash'], ['Archive', '\\Archive'], ['Junk', '\\Junk']
];

const defaultsFor = accountExpr => `INSERT INTO gateway_mailboxes(account_id,name,special_use)
 SELECT target.account_id,d.column1,d.column2 FROM (SELECT ${accountExpr} AS account_id) target CROSS JOIN (VALUES
 ('INBOX','\\Inbox'),('Sent','\\Sent'),('Drafts','\\Drafts'),
 ('Trash','\\Trash'),('Archive','\\Archive'),('Junk','\\Junk')) d
 WHERE NOT EXISTS(SELECT 1 FROM gateway_mailboxes b WHERE b.account_id=target.account_id AND b.name=d.column1);`;

// A visible legacy row has exactly one independently flagged protocol instance.
// Saving/unassigned/deleted mail must never appear as a successful empty or partial message.
export const projectEmailSQL = emailExpr => `INSERT INTO gateway_messages(id,account_id,mailbox_id,uid,email_id,raw_id,raw_error,size,flags,internal_date)
 SELECT lower(hex(randomblob(16))),e.account_id,b.id,b.uid_next,e.email_id,r.raw_id,f.code,
 COALESCE(o.size,f.size,0),(CASE WHEN e.unread=1 THEN 1 ELSE 0 END) |
 (CASE WHEN EXISTS(SELECT 1 FROM star s WHERE s.email_id=e.email_id AND s.user_id=e.user_id) THEN 4 ELSE 0 END),
 COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',e.create_time),'1970-01-01T00:00:00.000Z')
 FROM email e JOIN account a ON a.account_id=e.account_id AND a.user_id=e.user_id AND a.is_del=0
 JOIN gateway_mailboxes b ON b.account_id=e.account_id AND b.name=CASE WHEN e.type=1 THEN 'Sent' ELSE 'INBOX' END
 LEFT JOIN gateway_email_raw r ON r.email_id=e.email_id AND r.account_id=e.account_id
 LEFT JOIN gateway_raw o ON o.id=r.raw_id
 LEFT JOIN gateway_raw_failures f ON f.email_id=e.email_id AND f.account_id=e.account_id
 WHERE e.email_id=${emailExpr} AND e.is_del=0 AND e.status NOT IN(6,7,9)
 AND b.uid_next<4294967295 AND NOT EXISTS(SELECT 1 FROM gateway_messages m WHERE m.email_id=e.email_id);`;

export const GATEWAY_MIGRATION = [
`CREATE TABLE IF NOT EXISTS gateway_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`,
`CREATE TABLE IF NOT EXISTS gateway_accounts(
 account_id INTEGER PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,
 cursor_secret TEXT NOT NULL DEFAULT (lower(hex(randomblob(32)))),
 cursor_floor INTEGER NOT NULL DEFAULT 0);`,
`CREATE TABLE IF NOT EXISTS gateway_mailboxes(
 id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id BETWEEN 1 AND 4294967295),
 account_id INTEGER NOT NULL,name TEXT NOT NULL COLLATE NOCASE,special_use TEXT,
 subscribed INTEGER NOT NULL DEFAULT 1 CHECK(subscribed IN(0,1)),
 uid_next INTEGER NOT NULL DEFAULT 1 CHECK(uid_next BETWEEN 1 AND 4294967295),
 highest_mod_seq INTEGER NOT NULL DEFAULT 0,
 UNIQUE(account_id,name));`,
`CREATE TABLE IF NOT EXISTS gateway_raw(
 id TEXT PRIMARY KEY,account_id INTEGER NOT NULL,object_key TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size>=0),sha256 TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN('received','submission','append','reconstructed')),
 created_at INTEGER NOT NULL);`,
`CREATE TABLE IF NOT EXISTS gateway_email_raw(
 email_id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL,raw_id TEXT NOT NULL);`,
`CREATE TABLE IF NOT EXISTS gateway_raw_failures(
 email_id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL,code TEXT NOT NULL CHECK(code IN('RAW_TOO_LARGE','RAW_UNAVAILABLE')),
 size INTEGER NOT NULL CHECK(size>=0),created_at INTEGER NOT NULL);`,
`CREATE INDEX IF NOT EXISTS idx_gateway_raw_failures_account ON gateway_raw_failures(account_id);`,
`CREATE TABLE IF NOT EXISTS gateway_messages(
 id TEXT PRIMARY KEY,account_id INTEGER NOT NULL,mailbox_id INTEGER NOT NULL,uid INTEGER NOT NULL,
 email_id INTEGER UNIQUE,raw_id TEXT,raw_error TEXT,size INTEGER NOT NULL DEFAULT 0 CHECK(size>=0),
 flags INTEGER NOT NULL DEFAULT 0 CHECK(flags BETWEEN 0 AND 31),
 internal_date TEXT NOT NULL,mod_seq INTEGER NOT NULL DEFAULT 0,
 UNIQUE(mailbox_id,uid));`,
`CREATE INDEX IF NOT EXISTS idx_gateway_messages_account_raw ON gateway_messages(account_id,raw_id);`,
`CREATE TABLE IF NOT EXISTS gateway_changes(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER NOT NULL,mailbox_id INTEGER NOT NULL,
 type TEXT NOT NULL CHECK(type IN('added','flags','expunged')),uid INTEGER NOT NULL,
 flags INTEGER NOT NULL,size INTEGER NOT NULL,internal_date TEXT NOT NULL,raw_source TEXT,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()*1000));`,
`CREATE INDEX IF NOT EXISTS idx_gateway_changes_account_seq ON gateway_changes(account_id,seq);`,
`CREATE INDEX IF NOT EXISTS idx_gateway_changes_instance ON gateway_changes(mailbox_id,uid);`,
`CREATE TABLE IF NOT EXISTS gateway_credentials(
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,account_id INTEGER NOT NULL,name TEXT NOT NULL,
 password_hash TEXT NOT NULL,permissions TEXT NOT NULL,created_at INTEGER NOT NULL,
 last_used_at INTEGER,revoked_at INTEGER);`,
`CREATE INDEX IF NOT EXISTS idx_gateway_credentials_owner ON gateway_credentials(user_id,created_at);`,
`CREATE TABLE IF NOT EXISTS gateway_sessions(
 id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,credential_id TEXT NOT NULL,
 user_id INTEGER NOT NULL,account_id INTEGER NOT NULL,created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,revoked_at INTEGER);`,
`CREATE INDEX IF NOT EXISTS idx_gateway_sessions_credential ON gateway_sessions(credential_id,created_at);`,
`CREATE TABLE IF NOT EXISTS gateway_rate_limits(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL);`,
`CREATE INDEX IF NOT EXISTS idx_gateway_rate_limits_expiry ON gateway_rate_limits(expires_at);`,
`CREATE TABLE IF NOT EXISTS gateway_write_guard(
 id TEXT PRIMARY KEY,authorized INTEGER CONSTRAINT gateway_authorized CHECK(authorized=1),
 revision_ok INTEGER CONSTRAINT gateway_revision CHECK(revision_ok=1),
 capacity_ok INTEGER CONSTRAINT gateway_capacity CHECK(capacity_ok=1));`,
`CREATE TABLE IF NOT EXISTS gateway_appends(
 account_id INTEGER NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,
 mailbox_id INTEGER NOT NULL,uid INTEGER NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(account_id,idempotency_key));`,
`CREATE TABLE IF NOT EXISTS gateway_sent_copies(
 submission_id TEXT PRIMARY KEY,account_id INTEGER NOT NULL,email_id INTEGER NOT NULL,
 payload_hash TEXT NOT NULL,content_hash TEXT NOT NULL,envelope_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL,consumed_at INTEGER);`,
`CREATE INDEX IF NOT EXISTS idx_gateway_sent_match ON gateway_sent_copies(account_id,payload_hash,created_at);`,
`CREATE TABLE IF NOT EXISTS gateway_raw_leases(account_id INTEGER PRIMARY KEY,email_id INTEGER NOT NULL,token TEXT NOT NULL,expires_at INTEGER NOT NULL);`,
`CREATE TABLE IF NOT EXISTS gateway_submissions(
 id TEXT PRIMARY KEY,account_id INTEGER NOT NULL,user_id INTEGER NOT NULL,idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,payload_hash TEXT NOT NULL,envelope_json TEXT NOT NULL,raw_key TEXT NOT NULL,
 message_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL CHECK(state IN('sending','sent','failed','unknown')),
 phase TEXT NOT NULL DEFAULT 'preparing',result_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(account_id,idempotency_key));`,
`CREATE INDEX IF NOT EXISTS idx_gateway_submissions_account ON gateway_submissions(account_id,created_at DESC);`,
`CREATE INDEX IF NOT EXISTS idx_gateway_submissions_user ON gateway_submissions(user_id,created_at DESC);`,
`CREATE TRIGGER IF NOT EXISTS gateway_message_validate BEFORE INSERT ON gateway_messages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM gateway_mailboxes b WHERE b.id=NEW.mailbox_id AND b.account_id=NEW.account_id)
 THEN RAISE(ABORT,'gateway_mailbox_mismatch') END;
 SELECT CASE WHEN NEW.raw_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gateway_raw r WHERE r.id=NEW.raw_id AND r.account_id=NEW.account_id AND r.size=NEW.size)
 THEN RAISE(ABORT,'gateway_raw_mismatch') END;
 SELECT CASE WHEN (SELECT uid_next FROM gateway_mailboxes WHERE id=NEW.mailbox_id)>=4294967295
 THEN RAISE(ABORT,'gateway_uid_exhausted') END;
 SELECT CASE WHEN NEW.uid!=(SELECT uid_next FROM gateway_mailboxes WHERE id=NEW.mailbox_id)
 THEN RAISE(ABORT,'gateway_uid_conflict') END;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_message_identity BEFORE UPDATE OF account_id,mailbox_id,uid,email_id ON gateway_messages
 WHEN NEW.account_id!=OLD.account_id OR NEW.mailbox_id!=OLD.mailbox_id OR NEW.uid!=OLD.uid OR NEW.email_id IS NOT OLD.email_id
 BEGIN SELECT RAISE(ABORT,'gateway_immutable_identity'); END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_message_added AFTER INSERT ON gateway_messages BEGIN
 INSERT INTO gateway_changes(account_id,mailbox_id,type,uid,flags,size,internal_date,raw_source)
 VALUES(NEW.account_id,NEW.mailbox_id,'added',NEW.uid,NEW.flags,NEW.size,NEW.internal_date,COALESCE((SELECT source FROM gateway_raw WHERE id=NEW.raw_id),CASE WHEN NEW.raw_error IS NOT NULL THEN 'unavailable:'||NEW.raw_error END));
 UPDATE gateway_messages SET mod_seq=(SELECT max(seq) FROM gateway_changes) WHERE id=NEW.id;
 UPDATE gateway_mailboxes SET uid_next=uid_next+1,highest_mod_seq=(SELECT max(seq) FROM gateway_changes) WHERE id=NEW.mailbox_id;
 UPDATE gateway_accounts SET revision=revision+1 WHERE account_id=NEW.account_id;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_message_flags AFTER UPDATE OF flags,raw_id,size,raw_error ON gateway_messages
 WHEN NEW.flags!=OLD.flags OR NEW.raw_id IS NOT OLD.raw_id OR NEW.size!=OLD.size OR NEW.raw_error IS NOT OLD.raw_error BEGIN
 INSERT INTO gateway_changes(account_id,mailbox_id,type,uid,flags,size,internal_date,raw_source)
 VALUES(NEW.account_id,NEW.mailbox_id,'flags',NEW.uid,NEW.flags,NEW.size,NEW.internal_date,COALESCE((SELECT source FROM gateway_raw WHERE id=NEW.raw_id),CASE WHEN NEW.raw_error IS NOT NULL THEN 'unavailable:'||NEW.raw_error END));
 UPDATE gateway_messages SET mod_seq=(SELECT max(seq) FROM gateway_changes) WHERE id=NEW.id;
 UPDATE gateway_mailboxes SET highest_mod_seq=(SELECT max(seq) FROM gateway_changes) WHERE id=NEW.mailbox_id;
 UPDATE gateway_accounts SET revision=revision+1 WHERE account_id=NEW.account_id;
 UPDATE gateway_changes SET size=NEW.size,raw_source=COALESCE((SELECT source FROM gateway_raw WHERE id=NEW.raw_id),CASE WHEN NEW.raw_error IS NOT NULL THEN 'unavailable:'||NEW.raw_error END)
 WHERE mailbox_id=NEW.mailbox_id AND uid=NEW.uid AND type!='expunged' AND (NEW.raw_id IS NOT OLD.raw_id OR EXISTS(SELECT 1 FROM gateway_raw_failures WHERE email_id=NEW.email_id AND account_id=NEW.account_id));
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_message_removed AFTER DELETE ON gateway_messages BEGIN
 INSERT INTO gateway_changes(account_id,mailbox_id,type,uid,flags,size,internal_date,raw_source)
 VALUES(OLD.account_id,OLD.mailbox_id,'expunged',OLD.uid,OLD.flags,OLD.size,OLD.internal_date,(SELECT source FROM gateway_raw WHERE id=OLD.raw_id));
 UPDATE gateway_mailboxes SET highest_mod_seq=(SELECT max(seq) FROM gateway_changes) WHERE id=OLD.mailbox_id;
 UPDATE gateway_accounts SET revision=revision+1 WHERE account_id=OLD.account_id;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_mailbox_added AFTER INSERT ON gateway_mailboxes BEGIN
 UPDATE gateway_accounts SET revision=revision+1 WHERE account_id=NEW.account_id;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_mailbox_changed AFTER UPDATE OF name,subscribed ON gateway_mailboxes
 WHEN NEW.name!=OLD.name OR NEW.subscribed!=OLD.subscribed BEGIN
 UPDATE gateway_accounts SET revision=revision+1 WHERE account_id=NEW.account_id;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_mailbox_removed AFTER DELETE ON gateway_mailboxes BEGIN
 UPDATE gateway_accounts SET revision=revision+1 WHERE account_id=OLD.account_id;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_account_created AFTER INSERT ON account BEGIN
 INSERT OR IGNORE INTO gateway_accounts(account_id) VALUES(NEW.account_id);
 ${defaultsFor('NEW.account_id')}
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_account_transferred AFTER UPDATE OF user_id ON account
 WHEN NEW.user_id!=OLD.user_id BEGIN
 DELETE FROM gateway_messages WHERE account_id=OLD.account_id;
 DELETE FROM gateway_mailboxes WHERE account_id=OLD.account_id;
 DELETE FROM gateway_email_raw WHERE account_id=OLD.account_id;
 DELETE FROM gateway_changes WHERE account_id=OLD.account_id;
 UPDATE gateway_accounts SET revision=revision+1,cursor_secret=lower(hex(randomblob(32))),cursor_floor=COALESCE((SELECT max(seq) FROM gateway_changes),0) WHERE account_id=OLD.account_id;
 UPDATE gateway_credentials SET revoked_at=unixepoch()*1000 WHERE account_id=OLD.account_id AND revoked_at IS NULL;
 ${defaultsFor('NEW.account_id')}
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_account_removed AFTER DELETE ON account BEGIN
 DELETE FROM gateway_messages WHERE account_id=OLD.account_id;
 DELETE FROM gateway_mailboxes WHERE account_id=OLD.account_id;
 UPDATE gateway_credentials SET revoked_at=unixepoch()*1000 WHERE account_id=OLD.account_id AND revoked_at IS NULL;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_email_inserted AFTER INSERT ON email
 WHEN NEW.is_del=0 AND NEW.status NOT IN(6,7,9) AND NEW.account_id>0 BEGIN
 INSERT OR IGNORE INTO gateway_accounts(account_id) VALUES(NEW.account_id);
 ${defaultsFor('NEW.account_id')}
 ${projectEmailSQL('NEW.email_id')}
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_email_visible AFTER UPDATE OF is_del,status ON email
 WHEN NEW.is_del=0 AND NEW.status NOT IN(6,7,9) AND NEW.account_id>0 BEGIN
 INSERT OR IGNORE INTO gateway_accounts(account_id) VALUES(NEW.account_id);
 ${defaultsFor('NEW.account_id')}
 ${projectEmailSQL('NEW.email_id')}
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_email_hidden AFTER UPDATE OF is_del,status,user_id,account_id ON email
 WHEN NEW.is_del!=0 OR NEW.status IN(6,7,9) OR NEW.user_id!=OLD.user_id OR NEW.account_id!=OLD.account_id BEGIN
 DELETE FROM gateway_messages WHERE email_id=NEW.email_id;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_email_reassigned AFTER UPDATE OF user_id,account_id ON email
 WHEN NEW.user_id!=OLD.user_id OR NEW.account_id!=OLD.account_id BEGIN
 DELETE FROM gateway_email_raw WHERE email_id=NEW.email_id;
 DELETE FROM gateway_raw_failures WHERE email_id=NEW.email_id;
 DELETE FROM gateway_raw_leases WHERE email_id=NEW.email_id;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_email_deleted AFTER DELETE ON email BEGIN
 DELETE FROM gateway_messages WHERE email_id=OLD.email_id;
 DELETE FROM gateway_email_raw WHERE email_id=OLD.email_id;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_email_seen AFTER UPDATE OF unread ON email WHEN NEW.unread!=OLD.unread BEGIN
 UPDATE gateway_messages SET flags=(flags & ~1) | (CASE WHEN NEW.unread=1 THEN 1 ELSE 0 END) WHERE email_id=NEW.email_id;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_star_added AFTER INSERT ON star BEGIN
 UPDATE gateway_messages SET flags=flags | 4 WHERE email_id=NEW.email_id
 AND EXISTS(SELECT 1 FROM email e WHERE e.email_id=NEW.email_id AND e.user_id=NEW.user_id);
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_star_removed AFTER DELETE ON star
 WHEN NOT EXISTS(SELECT 1 FROM star s WHERE s.email_id=OLD.email_id AND s.user_id=OLD.user_id) BEGIN
 UPDATE gateway_messages SET flags=flags & ~4 WHERE email_id=OLD.email_id
 AND EXISTS(SELECT 1 FROM email e WHERE e.email_id=OLD.email_id AND e.user_id=OLD.user_id);
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_flags_to_web AFTER UPDATE OF flags ON gateway_messages
 WHEN NEW.email_id IS NOT NULL AND NEW.flags!=OLD.flags BEGIN
 UPDATE email SET unread=CASE WHEN (NEW.flags & 1)!=0 THEN 1 ELSE 0 END WHERE email_id=NEW.email_id;
 INSERT INTO star(user_id,email_id) SELECT e.user_id,e.email_id FROM email e
 WHERE e.email_id=NEW.email_id AND (NEW.flags & 4)!=0 AND NOT EXISTS(SELECT 1 FROM star s WHERE s.email_id=e.email_id AND s.user_id=e.user_id);
 DELETE FROM star WHERE email_id=NEW.email_id AND (NEW.flags & 4)=0;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_email_raw_attached AFTER INSERT ON gateway_email_raw BEGIN
 DELETE FROM gateway_raw_failures WHERE email_id=NEW.email_id AND account_id=NEW.account_id;
 UPDATE gateway_messages SET raw_id=NEW.raw_id,raw_error=NULL,size=(SELECT size FROM gateway_raw WHERE id=NEW.raw_id)
 WHERE email_id=NEW.email_id AND account_id=NEW.account_id AND raw_id IS NULL;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_raw_failure_added AFTER INSERT ON gateway_raw_failures BEGIN
 UPDATE gateway_messages SET size=NEW.size,raw_error=NEW.code WHERE email_id=NEW.email_id AND account_id=NEW.account_id AND raw_id IS NULL;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_raw_failure_updated AFTER UPDATE OF size,code ON gateway_raw_failures BEGIN
 UPDATE gateway_messages SET size=NEW.size,raw_error=NEW.code WHERE email_id=NEW.email_id AND account_id=NEW.account_id AND raw_id IS NULL;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_raw_failure_deleted AFTER DELETE ON gateway_raw_failures BEGIN
 UPDATE gateway_messages SET size=0,raw_error=NULL WHERE email_id=OLD.email_id AND account_id=OLD.account_id AND raw_id IS NULL;
 END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_raw_immutable BEFORE UPDATE ON gateway_raw BEGIN
 SELECT RAISE(ABORT,'gateway_immutable_raw'); END;`,
`CREATE TRIGGER IF NOT EXISTS gateway_message_raw_validate BEFORE UPDATE OF raw_id,size ON gateway_messages BEGIN
 SELECT CASE WHEN OLD.raw_id IS NOT NULL AND NEW.raw_id IS NOT OLD.raw_id THEN RAISE(ABORT,'gateway_immutable_raw') END;
 SELECT CASE WHEN NEW.raw_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gateway_raw r WHERE r.id=NEW.raw_id AND r.account_id=NEW.account_id AND r.size=NEW.size)
 THEN RAISE(ABORT,'gateway_raw_mismatch') END; END;`,
`CREATE INDEX IF NOT EXISTS idx_gateway_legacy_projection ON email(account_id,user_id,is_del,status,email_id);`,
`INSERT OR IGNORE INTO gateway_meta(key,value) VALUES('schema_version','1');`
];

export async function applyGatewayMigration(c) {
	// batch is a D1 transaction: a failed statement cannot leave half-installed triggers.
	await c.env.db.batch(GATEWAY_MIGRATION.map(sql => c.env.db.prepare(sql)));
}

export { defaultsFor };
