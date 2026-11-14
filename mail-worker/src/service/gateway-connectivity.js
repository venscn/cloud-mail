import { normalizeGatewayHostname } from '../utils/gateway-settings.js';

export class ProbeError extends Error {
	constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ProbeError(code); };
export const PROBE_CODES = ['INVALID_REQUEST', 'FORBIDDEN', 'NOT_CONFIGURED', 'RATE_LIMITED', 'DNS_FAILED', 'ADDRESS_BLOCKED', 'CONNECT_TLS_FAILED', 'PROTOCOL_FAILED', 'LIMIT_EXCEEDED', 'TIMEOUT', 'CANCELLED', 'UNAVAILABLE'];

// Conservative public-unicast allowlist. IPv6 transition/mapped forms are never accepted.
export function isPublicAddress(address) {
	if (typeof address !== 'string') return false;
	if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) {
		const p = address.split('.');
		if (p.some(v => String(Number(v)) !== v || Number(v) > 255)) return false;
		const [a,b,c] = p.map(Number);
		return !(a === 0 || a === 10 || a === 127 || a >= 224
			|| (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
			|| (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
			|| (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
			|| (a === 203 && b === 0 && c === 113)
			// Conservatively exclude cloud-provider virtual/metadata service subnet.
			|| (a === 168 && b === 63));
	}
	if (!/^[0-9a-f:]+$/i.test(address) || address.includes(':::')) return false;
	const halves = address.toLowerCase().split('::');
	if (halves.length > 2) return false;
	const left = halves[0] ? halves[0].split(':') : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	if ([...left,...right].some(v => !/^[0-9a-f]{1,4}$/.test(v))) return false;
	if (halves.length === 1 ? left.length !== 8 : left.length + right.length >= 8) return false;
	const groups = halves.length === 1 ? left : [...left, ...Array(8-left.length-right.length).fill('0'), ...right];
	const [a,b] = groups.map(v => parseInt(v,16));
	return a >= 0x2000 && a <= 0x3fff && a !== 0x2002
		&& !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8))
		&& !(a === 0x3fff && b <= 0xfff);
}

async function boundedJson(response, wait) {
	if (!response.ok || !response.body) fail('DNS_FAILED');
	const reader = response.body.getReader();
	let bytes = 0, text = '';
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const {done, value} = await wait(reader.read());
			if (done) break;
			bytes += value.byteLength;
			if (bytes > 16384) fail('LIMIT_EXCEEDED');
			text += decoder.decode(value, {stream:true});
		}
		return JSON.parse(text + decoder.decode());
	} finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function resolvePublicHost(host, fetcher, signal, wait, addressPolicy = isPublicAddress) {
	const addresses = [];
	for (const type of ['A','AAAA']) {
		let body;
		try {
			const url = new URL('https://cloudflare-dns.com/dns-query');
			url.searchParams.set('name',host); url.searchParams.set('type',type);
			body = await boundedJson(await wait(fetcher(url.toString(), {
				headers:{Accept:'application/dns-json'}, redirect:'error', signal
			})), wait);
		} catch (e) { if (e instanceof ProbeError) throw e; fail('DNS_FAILED'); }
		if (body.Status !== 0 || body.TC === true || !Array.isArray(body.Question)
			|| body.Question.length !== 1 || body.Question[0].name?.replace(/\.$/,'').toLowerCase() !== host
			|| body.Question[0].type !== (type === 'A' ? 1 : 28)) fail('DNS_FAILED');
		if (body.Answer !== undefined && !Array.isArray(body.Answer)) fail('DNS_FAILED');
		if ((body.Answer || []).length > 32) fail('LIMIT_EXCEEDED');
		for (const answer of body.Answer || []) {
			if (answer.type === 1 || answer.type === 28) {
				if (!addressPolicy(answer.data)) fail('ADDRESS_BLOCKED');
				addresses.push(answer.data);
			} else if (answer.type !== 5) fail('DNS_FAILED');
		}
	}
	if (!addresses.length) fail('DNS_FAILED');
}

// No IP pin: production Cloudflare proxy resolves the original DNS hostname,
// supplies TLS and rejects private/localhost/Cloudflare destinations at egress.
// Local mocks/workerd are NOT evidence of the production egress policy.
export async function probeGateway(protocol, rawHost, {connect, fetcher = fetch, signal, timeoutMs = 10000, addressPolicy = isPublicAddress} = {}) {
	const stages = {dns:'pending', secureConnection:'pending', protocol:'pending'};
	let host;
	try { host = normalizeGatewayHostname(rawHost); } catch { return {ok:false, code:'NOT_CONFIGURED', stages}; }
	if (!host) return {ok:false, code:'NOT_CONFIGURED', stages};
	if (!['imap','smtp'].includes(protocol)) return {ok:false, code:'INVALID_REQUEST', stages};
	const abort = new AbortController();
	let rejectStop;
	const stop = new Promise((_,reject) => { rejectStop = reject; });
	const cancel = () => { abort.abort(); rejectStop(new ProbeError('CANCELLED')); };
	const timer = setTimeout(() => { abort.abort(); rejectStop(new ProbeError('TIMEOUT')); }, timeoutMs);
	signal?.addEventListener('abort',cancel,{once:true});
	if (signal?.aborted) cancel();
	const wait = promise => Promise.race([promise,stop]);
	let socket, reader, writer, stage = 'dns', bytes = 0, lines = 0, buffer = '';
	const decoder = new TextDecoder('utf-8',{fatal:true});
	async function line() {
		for (;;) {
			const end = buffer.indexOf('\r\n');
			if (end >= 0) {
				if (++lines > 64 || end > 2048) fail('LIMIT_EXCEEDED');
				const value = buffer.slice(0,end);
				if (new TextEncoder().encode(value).byteLength > 2048) fail('LIMIT_EXCEEDED');
				buffer = buffer.slice(end+2); return value;
			}
			if (buffer.length > 2048) fail('LIMIT_EXCEEDED');
			const chunk = await wait(reader.read());
			if (chunk.done) { decoder.decode(); fail('PROTOCOL_FAILED'); }
			bytes += chunk.value.byteLength;
			if (bytes > 16384) fail('LIMIT_EXCEEDED');
			buffer += decoder.decode(chunk.value,{stream:true});
		}
	}
	const write = text => wait(writer.write(new TextEncoder().encode(text+'\r\n')));
	async function smtpReply(code) {
		for (;;) { const value = await line(); if (!value.startsWith(code+' ') && !value.startsWith(code+'-')) fail('PROTOCOL_FAILED'); if (value[3] === ' ') return; }
	}
	try {
		await resolvePublicHost(host,fetcher,abort.signal,wait,addressPolicy);
		stages.dns = 'passed'; stage = 'secureConnection';
		socket = connect({hostname:host, port:protocol === 'imap' ? 993 : 465},{secureTransport:'on',allowHalfOpen:false});
		// Always observe closed rejection, including handshake/connect failures.
		socket.closed.catch(() => {});
		await wait(socket.opened);
		stages.secureConnection = 'passed'; stage = 'protocol';
		reader = socket.readable.getReader(); writer = socket.writable.getWriter();
		if (protocol === 'smtp') {
			await smtpReply('220'); await write('EHLO probe.example.com'); await smtpReply('250');
			await write('QUIT'); await smtpReply('221');
		} else {
			if (!/^\* OK(?: |$)/i.test(await line())) fail('PROTOCOL_FAILED');
			await write('a1 CAPABILITY');
			let capability = false;
			for (;;) {
				const value = await line();
				if (/^\* CAPABILITY .+/i.test(value)) capability = true;
				else if (/^a1 OK(?: |$)/i.test(value)) { if (!capability) fail('PROTOCOL_FAILED'); break; }
				else fail('PROTOCOL_FAILED');
			}
			await write('a2 LOGOUT');
			let bye = false;
			for (;;) {
				const value = await line();
				if (/^\* BYE(?: |$)/i.test(value)) bye = true;
				else if (/^a2 OK(?: |$)/i.test(value) && bye) break;
				else fail('PROTOCOL_FAILED');
			}
		}
		decoder.decode(); // Reject a truncated UTF-8 sequence already consumed after the final reply.
		stages.protocol = 'passed'; return {ok:true, code:'OK', stages};
	} catch (e) {
		stages[stage] = 'failed';
		return {ok:false, code:e instanceof ProbeError ? e.code : stage === 'dns' ? 'DNS_FAILED' : stage === 'secureConnection' ? 'CONNECT_TLS_FAILED' : 'PROTOCOL_FAILED', stages};
	} finally {
		clearTimeout(timer); signal?.removeEventListener('abort',cancel); abort.abort();
		// Initiate cancellation/closure without allowing an unresponsive close to hang the request.
		if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
		if (writer) { void writer.abort().catch(() => {}); writer.releaseLock(); }
		if (socket) { try { void socket.close().catch(() => {}); } catch {} }
	}
}
