import {describe,it,expect,vi} from 'vitest';
import {isPublicAddress,probeGateway,resolvePublicHost} from '../../src/service/gateway-connectivity.js';
const host = 'mail.example.test';
// Documentation-only address. The injected policy is a synthetic success harness,
// never a claim that these streams reproduce Cloudflare production egress/TLS.
const documentationPolicy = value => value === '192.0.2.1';
function doh(addresses = ['192.0.2.1']) {
	return vi.fn(async url => {
		const u = new URL(url); const type = u.searchParams.get('type') === 'A' ? 1 : 28;
		return Response.json({Status:0,Question:[{name:host,type}],Answer:type === 1 ? addresses.map(data => ({type:1,data})) : []});
	});
}
function socketFixture(text, {opened = Promise.resolve({}), hang = false, chunks} = {}) {
	const writes = []; const cancel = vi.fn();
	const readable = new ReadableStream({start(c) {for (const chunk of chunks || (text ? [new TextEncoder().encode(text)] : [])) c.enqueue(chunk); if (!hang) c.close();},cancel});
	const socket = {opened,closed:opened.then(() => undefined),readable,writable:new WritableStream({write(v){writes.push(new TextDecoder().decode(v));}}),close:vi.fn(async () => {})};
	return {socket,writes,cancel,connect:vi.fn(() => socket)};
}
const smtp = '220 synthetic\r\n250-example.test\r\n250 AUTH PLAIN\r\n221 goodbye\r\n';
const imap = '* OK synthetic\r\n* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\na1 OK done\r\n* BYE logout\r\na2 OK done\r\n';
describe('public address defense',() => {
	it.each(['0.0.0.0','10.0.0.1','127.0.0.1','100.64.0.1','169.254.169.254','172.16.0.1','192.168.0.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','012.0.0.1','256.0.0.1','::','::1','::ffff:127.0.0.1','::ffff:7f00:1','fe80::1','fc00::1','ff02::1','64:ff9b::1','2001:db8::1','2002::1','3fff::1','2001::1','[::1]','1:2:3'])('rejects %s', value => expect(isPublicAddress(value)).toBe(false));
	it('fails closed for private and mixed records before connect',async () => {
		for (const values of [['127.0.0.1'],['192.0.2.1','169.254.169.254']]) {
			const connect = vi.fn();
			const result = await probeGateway('imap',host,{connect,fetcher:doh(values)});
			expect(result.code).toBe('ADDRESS_BLOCKED'); expect(connect).not.toHaveBeenCalled();
		}
	});
	it('uses fixed trusted HTTPS DoH, no redirects, requested host and bounded response',async () => {
		const fetcher = doh();
		await resolvePublicHost(host,fetcher,undefined,p => p,documentationPolicy);
		for (const [url,opts] of fetcher.mock.calls) {
			expect(new URL(url).origin).toBe('https://cloudflare-dns.com'); expect(new URL(url).searchParams.get('name')).toBe(host); expect(opts.redirect).toBe('error');
		}
		await expect(resolvePublicHost(host,async () => new Response('x'.repeat(17000)),undefined,p=>p)).rejects.toMatchObject({code:'LIMIT_EXCEEDED'});
		await expect(resolvePublicHost(host,async () => Response.json({Status:3}),undefined,p=>p)).rejects.toMatchObject({code:'DNS_FAILED'});
	});
});
describe('bounded unauthenticated protocols',() => {
	it.each([['imap',imap,993,'a1 CAPABILITY\r\na2 LOGOUT\r\n'],['smtp',smtp,465,'EHLO probe.example.com\r\nQUIT\r\n']])('probes %s with original DNS and implicit TLS only',async (protocol,text,port,commands) => {
		const f = socketFixture(text); const result = await probeGateway(protocol,host,{...f,fetcher:doh(),addressPolicy:documentationPolicy});
		expect(result).toEqual({ok:true,code:'OK',stages:{dns:'passed',secureConnection:'passed',protocol:'passed'}});
		expect(f.connect).toHaveBeenCalledWith({hostname:host,port},{secureTransport:'on',allowHalfOpen:false});
		expect(f.writes.join('')).toBe(commands); expect(f.socket.close).toHaveBeenCalledOnce();
		expect(f.writes.join('')).not.toMatch(/AUTH|LOGIN|MAIL FROM|RCPT|DATA|SELECT|FETCH/);
	});
	it.each([['imap',imap],['smtp',smtp]])('accepts %s greeting UTF-8 split across byte boundaries',async (protocol,text) => {
		const encoded = new TextEncoder().encode(text.replace('synthetic','欢迎'));
		const chunks = Array.from(encoded,byte => new Uint8Array([byte]));
		const f = socketFixture('',{chunks});
		const result = await probeGateway(protocol,host,{...f,fetcher:doh(),addressPolicy:documentationPolicy});
		expect(result.ok).toBe(true); expect(f.socket.close).toHaveBeenCalledOnce();
		expect(f.writes.join('')).not.toMatch(/AUTH|LOGIN|MAIL FROM|RCPT|DATA/);
	});
	it.each([
		[new TextEncoder().encode('220 '),new Uint8Array([0xe6]),new Uint8Array([0x28,0x8e]),new TextEncoder().encode('\r\n')],
		[new TextEncoder().encode('220 '),new Uint8Array([0xe6,0xac])],
		[new Uint8Array([...new TextEncoder().encode(smtp),0xe6])]
	].map(chunks => [chunks]))('rejects malformed/truncated streamed UTF-8 and closes without raw banner %#',async chunks => {
		const f = socketFixture('',{chunks});
		const result = await probeGateway('smtp',host,{...f,fetcher:doh(),addressPolicy:documentationPolicy,timeoutMs:100});
		expect(result).toMatchObject({ok:false,code:'PROTOCOL_FAILED'}); expect(f.socket.close).toHaveBeenCalledOnce();
		expect(JSON.stringify(result)).not.toContain('220');
	});
	it('enforces byte limits on streamed multibyte banners and closes',async () => {
		const f = socketFixture('',{chunks:[new TextEncoder().encode('220 '+ '欢'.repeat(800) +'\r\n')],hang:true});
		const result = await probeGateway('smtp',host,{...f,fetcher:doh(),addressPolicy:documentationPolicy});
		expect(result).toMatchObject({ok:false,code:'LIMIT_EXCEEDED'}); expect(f.socket.close).toHaveBeenCalledOnce();
	});
	it.each(['certificate failure','proxy request failed, cannot connect to the specified address','TCP Loop detected'])('fails closed on platform TLS/egress rejection without raw details (%s)',async reason => {
		const f = socketFixture('',{opened:Promise.reject(new Error(reason))});
		const result = await probeGateway('smtp',host,{...f,fetcher:doh(),addressPolicy:documentationPolicy});
		expect(result.code).toBe('CONNECT_TLS_FAILED'); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(reason); expect(f.socket.close).toHaveBeenCalledOnce();
	});
	it('rebinding defense is delegated: provider rejects actual private egress, not mocked as successful',async () => {
		const f = socketFixture('',{opened:Promise.reject(new Error('synthetic platform actual-address rejection'))});
		const result = await probeGateway('imap',host,{...f,fetcher:doh(),addressPolicy:documentationPolicy});
		expect(result.stages).toEqual({dns:'passed',secureConnection:'failed',protocol:'pending'}); expect(f.writes).toEqual([]);
	});
	it.each(['220 '+'x'.repeat(2100)+'\r\n', '220 '+'x'.repeat(17000)+'\r\n', '220-a\r\n'.repeat(65), '500 bad\r\n'])('bounds malformed or excessive responses',async text => {
		const f = socketFixture(text); const result = await probeGateway('smtp',host,{...f,fetcher:doh(),addressPolicy:documentationPolicy});
		expect(result.ok).toBe(false); expect(f.socket.close).toHaveBeenCalledOnce();
	});
	it('times out, cancels reader and closes socket',async () => {
		const f = socketFixture('',{hang:true});
		const result = await probeGateway('smtp',host,{...f,fetcher:doh(),addressPolicy:documentationPolicy,timeoutMs:15});
		expect(result.code).toBe('TIMEOUT'); expect(f.socket.close).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalled();
	});
	it('request cancellation aborts DNS without any connection',async () => {
		const controller = new AbortController(); const connect = vi.fn();
		const pending = probeGateway('imap',host,{connect,fetcher:()=>new Promise(()=>{}),signal:controller.signal}); controller.abort();
		expect((await pending).code).toBe('CANCELLED'); expect(connect).not.toHaveBeenCalled();
	});
	it('invalid/missing saved host never opens a socket',async () => {
		for (const h of ['',undefined,'https://mail.example.test','127.0.0.1']) expect((await probeGateway('imap',h)).code).toBe('NOT_CONFIGURED');
	});
});
