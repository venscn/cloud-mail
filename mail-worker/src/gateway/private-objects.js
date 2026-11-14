// All legacy/public object routes call this BEFORE selecting a storage backend.
// Do not put this check on the internal getObj helper used by authorized services.
export function isPrivateObjectKey(key) {
	if (typeof key !== 'string' || /[\x00-\x1f]/.test(key)) return true;
	for (let i = 0; i < 8; i++) {
		if (key.replace(/\\/g, '/').split('/').some(part => part.toLowerCase() === 'private-gateway')) return true;
		if (!key.includes('%')) return false;
		let decoded;
		try { decoded = decodeURIComponent(key); } catch { return true; }
		if (decoded === key) return false;
		key = decoded;
	}
	return true; // Over-encoded, ambiguous public paths fail closed.
}
