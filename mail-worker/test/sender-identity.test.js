import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Email, WorkerMailer } from 'worker-mailer';
import PostalMime from 'postal-mime';
import smtpSendService from '../src/service/smtp-send-service';
import emailService from '../src/service/email-service';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));
vi.mock('resend', () => ({
	Resend: class {
		constructor() {
			this.emails = { send: resendSend };
		}
	}
}));

const smtpConfig = (overrides = {}) => ({
	host: 'smtp.example.test',
	port: 465,
	secure: true,
	credentials: { username: 'smtp-login@example.test', password: 'not-a-real-secret' },
	envelopeFrom: 'admin@example.com',
	...overrides
});

const message = (overrides = {}) => ({
	name: 'alice',
	accountEmail: 'alice@example.com',
	receiveEmail: ['recipient@example.test'],
	ccEmail: [],
	bccEmail: [],
	subject: 'Sender identity regression',
	text: 'Original plain text',
	html: '<p>Original HTML</p>',
	attachments: [],
	sendType: 'new',
	...overrides
});

// Exercise production form generation and worker-mailer MIME serialization, while
// replacing only the SMTP connection boundary so these tests can never send mail.
let smtpSend;
let smtpClose;
let connect;
beforeEach(() => {
	smtpSend = vi.fn().mockResolvedValue(undefined);
	smtpClose = vi.fn().mockResolvedValue(undefined);
	connect = vi.spyOn(WorkerMailer, 'connect').mockResolvedValue({ send: smtpSend, close: smtpClose });
	resendSend.mockReset().mockResolvedValue({ data: { id: 'resend-id' } });
});
afterEach(() => vi.restoreAllMocks());

const sentForm = () => {
	expect(smtpSend).toHaveBeenCalledTimes(1);
	return smtpSend.mock.calls[0][0];
};
const parseForm = async form => {
	const email = new Email(form);
	const raw = email.getEmailData();
	return { envelope: email.from.email, raw, parsed: await PostalMime.parse(raw) };
};


describe('SMTP envelope configuration', () => {
	it('prefers an explicit saved envelope over the environment fallback', () => {
		const c = { env: { sendpulse_smtp_user: 'login', sendpulse_smtp_pass: 'placeholder', sendpulse_smtp_envelope_from: 'env@example.com' } };
		const config = smtpSendService.getSmtpConfig(c, 'sendpulse', { sendpulse: { envelopeFrom: ' saved@example.com ' } });
		expect(config.envelopeFrom).toBe('saved@example.com');
	});

	it('allows clearing the saved envelope rather than silently reusing an environment override', () => {
		const c = { env: { sendpulse_smtp_user: 'login', sendpulse_smtp_pass: 'placeholder', sendpulse_smtp_envelope_from: 'env@example.com' } };
		expect(smtpSendService.getSmtpConfig(c, 'sendpulse', { sendpulse: { envelopeFrom: '' } }).envelopeFrom).toBe('');
		expect(smtpSendService.getSmtpConfig(c, 'sendpulse', {}).envelopeFrom).toBe('env@example.com');
	});
});


describe('SendPulse sender identity', () => {
	it('separates the authorized envelope from the actual lowercase visible sender', async () => {
		await smtpSendService.sendBySendPulse(smtpConfig(), message());
		const form = sentForm();
		expect(form.from.email).toBe('admin@example.com');
		expect(form.headers.From).toBe('"alice" <alice@example.com>');
		const { envelope, parsed } = await parseForm(form);
		expect(envelope).toBe('admin@example.com');
		expect(parsed.from).toMatchObject({ address: 'alice@example.com', name: 'alice' });
		expect(smtpClose).toHaveBeenCalledOnce();
	});

	it('preserves explicit From while adding reply threading headers', async () => {
		const messageId = '<previous@example.test>';
		await smtpSendService.sendBySendPulse(smtpConfig(), message({ sendType: 'reply', messageId }));
		const form = sentForm();
		expect(form.headers).toMatchObject({ From: '"alice" <alice@example.com>', 'in-reply-to': messageId, references: messageId });
		const { parsed, raw } = await parseForm(form);
		expect(parsed.from.address).toBe('alice@example.com');
		expect(raw).toMatch(/in-reply-to: <previous@example\.test>/i);
		expect(raw).toMatch(/references: <previous@example\.test>/i);
	});

	it.each(['new-unregistered@example.com', 'any.other+tag@example.com'])('keeps dynamic same-domain From %s instead of an administrator constant', async accountEmail => {
		await smtpSendService.sendBySendPulse(smtpConfig(), message({ accountEmail }));
		const { parsed } = await parseForm(sentForm());
		expect(parsed.from.address).toBe(accountEmail);
	});

	it('preserves MIME Reply-To when SendPulse uses a different same-domain envelope sender', async () => {
		await smtpSendService.sendBySendPulse(smtpConfig(), message({ gateway: { headers: { 'Reply-To': 'support@example.test' } } }));
		const { parsed } = await parseForm(sentForm());
		expect(parsed.from).toMatchObject({ address: 'alice@example.com', name: 'alice' });
		expect(parsed.replyTo[0].address).toBe('support@example.test');
	});

	it('compares envelope and visible domains case-insensitively', async () => {
		await smtpSendService.sendBySendPulse(smtpConfig({ envelopeFrom: 'admin@example.com' }), message());
		expect(sentForm().from.email).toBe('admin@example.com');
	});

	it('uses the actual account as envelope when no override is configured', async () => {
		await smtpSendService.sendBySendPulse(smtpConfig({ envelopeFrom: '' }), message());
		const { envelope, parsed } = await parseForm(sentForm());
		expect(envelope).toBe('alice@example.com');
		expect(parsed.from).toMatchObject({ address: 'alice@example.com', name: 'alice' });
	});

	it.each(['周星', 'a "quoted" name', 'a \\ backslash', '周星 "quoted"'])('round-trips display name %s through actual MIME generation', async name => {
		await smtpSendService.sendBySendPulse(smtpConfig(), message({ name }));
		const { parsed } = await parseForm(sentForm());
		expect(parsed.from).toMatchObject({ address: 'alice@example.com', name });
	});

	it('sanitizes CRLF in the display name without injecting MIME headers', async () => {
		await smtpSendService.sendBySendPulse(smtpConfig(), message({ name: 'alice\r\nX-Injected: evil' }));
		const form = sentForm();
		expect(form.headers.From).not.toMatch(/[\r\n]/);
		const { parsed, raw } = await parseForm(form);
		expect(parsed.from.address).toBe('alice@example.com');
		expect(parsed.from.name).toContain('alice');
		expect(raw).not.toMatch(/(?:^|\r?\n)X-Injected:/i);
	});

	it('does not mutate the input message or SMTP config', async () => {
		const params = message({ sendType: 'reply', messageId: '<original@example.test>' });
		const config = smtpConfig();
		const original = structuredClone({ params, config });
		await smtpSendService.sendBySendPulse(config, params);
		expect({ params, config }).toEqual(original);
	});

	it.each(['not-an-address', 'Name <admin@example.com>', 'a@example.com\r\nBcc: victim@example.test', 'a@example.com,b@example.com', 'a@@example.com', 'a b@example.com', 123])('rejects invalid envelope %j before connecting', async envelopeFrom => {
		await expect(smtpSendService.sendBySendPulse(smtpConfig({ envelopeFrom }), message())).rejects.toThrow(/invalid/i);
		expect(connect).not.toHaveBeenCalled();
	});

	it('rejects a cross-domain envelope before connecting', async () => {
		await expect(smtpSendService.sendBySendPulse(smtpConfig({ envelopeFrom: 'admin@other.test' }), message())).rejects.toThrow(/same domain/i);
		expect(connect).not.toHaveBeenCalled();
	});

	it('closes the SMTP connection after a send failure', async () => {
		smtpSend.mockRejectedValueOnce(new Error('rejected by provider'));
		await expect(smtpSendService.sendBySendPulse(smtpConfig(), message())).rejects.toThrow('rejected by provider');
		expect(smtpClose).toHaveBeenCalledOnce();
	});
});


describe('QQ sender identity fallback', () => {
	const qqConfig = () => smtpConfig({ credentials: { username: 'synthetic-sender@qq.com', password: 'not-a-real-secret' }, envelopeFrom: '' });

	it('uses QQ login for From, actual account for Reply-To, and adds both body notices', async () => {
		await smtpSendService.sendByQq(qqConfig(), message());
		const form = sentForm();
		expect(form.from).toMatchObject({ email: 'synthetic-sender@qq.com', name: 'alice' });
		expect(form.reply).toMatchObject({ email: 'alice@example.com', name: 'alice' });
		expect(form.text).toContain('Original plain text');
		expect(form.text).toMatch(/^实际发件邮箱：alice@example\.com/);
		expect(form.text.indexOf('alice@example.com')).toBeLessThan(form.text.indexOf('Original plain text'));
		expect(form.html).toContain('<p>Original HTML</p>');
		expect(form.html.indexOf('alice@example.com')).toBeLessThan(form.html.indexOf('<p>Original HTML</p>'));
		expect(form.html).toContain('alice@example.com');
		const { envelope, parsed } = await parseForm(form);
		expect(envelope).toBe('synthetic-sender@qq.com');
		expect(parsed.from).toMatchObject({ address: 'synthetic-sender@qq.com', name: 'alice' });
		expect(parsed.replyTo).toEqual([expect.objectContaining({ address: 'alice@example.com' })]);
	});

	it('HTML-escapes the actual mailbox in its leading notice instead of allowing markup injection', async () => {
		// Ampersand and apostrophe are permitted mailbox characters and require HTML escaping.
		const accountEmail = 'a&b\'@example.com';
		await smtpSendService.sendByQq(qqConfig(), message({ accountEmail }));
		const form = sentForm();
		expect(form.text).toContain(accountEmail);
		expect(form.html).toContain('a&amp;b');
		expect(form.html).toMatch(/(?:&#39;|&#x27;|&apos;)@example\.com/);
		expect(form.html).not.toContain(accountEmail);
		expect(form.html).not.toContain('<b>');
	});

	it.each(['a<b>@example.com', 'a"b@example.com', 'a@example.com\r\nBcc: hidden@example.test'])('rejects unsafe actual mailbox %j before connecting', async accountEmail => {
		await expect(smtpSendService.sendByQq(qqConfig(), message({ accountEmail }))).rejects.toThrow(/invalid/i);
		expect(connect).not.toHaveBeenCalled();
	});

	it('sanitizes the name used by the QQ From and Reply-To headers', async () => {
		await smtpSendService.sendByQq(qqConfig(), message({ name: 'alice\r\nX-Injected: evil' }));
		const { raw, parsed } = await parseForm(sentForm());
		expect(raw).not.toMatch(/(?:^|\r?\n)X-Injected:/i);
		expect(parsed.from.address).toBe('synthetic-sender@qq.com');
		expect(parsed.replyTo[0].address).toBe('alice@example.com');
	});

	it('inserts the HTML identity notice at the start of a complete document body', async () => {
		await smtpSendService.sendByQq(qqConfig(), message({ html: '<html><body class="mail"><p>Original HTML</p></body></html>' }));
		const html = sentForm().html;
		expect(html.indexOf('alice@example.com')).toBeGreaterThan(html.indexOf('<body class="mail">'));
		expect(html.indexOf('alice@example.com')).toBeLessThan(html.indexOf('<p>Original HTML</p>'));
		expect(html).toMatch(/<\/body><\/html>$/);
	});

	it.each([
		{ text: 'Plain only', html: '' },
		{ text: '', html: '<p>HTML only</p>' }
	])('preserves existing body content when only one format is supplied: %j', async body => {
		await smtpSendService.sendByQq(qqConfig(), message(body));
		const form = sentForm();
		if (body.text) {
			expect(form.text).toContain(body.text);
			expect(form.text).toContain('alice@example.com');
		}
		if (body.html) {
			expect(form.html).toContain(body.html);
			expect(form.html).toContain('alice@example.com');
		}
	});

	it('does not mutate message bodies, recipient arrays, or attachments', async () => {
		const params = message({
			ccEmail: ['copy@example.test'],
			bccEmail: ['hidden@example.test'],
			attachments: [{ filename: 'note.txt', content: 'bm90ZQ==', mimeType: 'text/plain' }],
			sendType: 'reply',
			messageId: '<qq-thread@example.test>'
		});
		const original = structuredClone(params);
		await smtpSendService.sendByQq(qqConfig(), params);
		expect(params).toEqual(original);
		const form = sentForm();
		expect(form.to).not.toBe(params.receiveEmail);
		expect(form.cc).not.toBe(params.ccEmail);
		expect(form.bcc).not.toBe(params.bccEmail);
		expect(form.headers).toMatchObject({ 'in-reply-to': params.messageId, references: params.messageId });
	});
});


describe('Sending channel priority', () => {
	const configured = () => ({
		resendToken: 'test-placeholder-token',
		smtpChannels: {
			sendpulse: { user: 'smtp-login@example.test', pass: 'placeholder' },
			qq: { user: 'qq-login@example.test', pass: 'placeholder' }
		}
	});
	it.each([undefined, []])('defaults to Resend, SendPulse, QQ, CF when order is %j', sendChain => {
		const channels = emailService.buildChannelChain({ env: { email: {} } }, { ...configured(), sendChain });
		expect(channels.map(channel => channel.name)).toEqual(['resend', 'sendpulse', 'qq', 'cf']);
		expect(connect).not.toHaveBeenCalled();
	});
	it('continues to honor an administrator-defined priority', () => {
		const sendChain = ['qq', 'resend', 'sendpulse', 'cf'];
		const channels = emailService.buildChannelChain({ env: { email: {} } }, { ...configured(), sendChain });
		expect(channels.map(channel => channel.name)).toEqual(sendChain);
	});
	it('skips unavailable Resend without disturbing the remaining priority', () => {
		const channels = emailService.buildChannelChain({ env: { email: {} } }, { ...configured(), resendToken: '' });
		expect(channels.map(channel => channel.name)).toEqual(['sendpulse', 'qq', 'cf']);
	});
});


describe('API channel sender identity', () => {
	it.each(['alice@example.com', 'any.other@example.com'])('Cloudflare binding receives actual account %s and unmodified display name', async accountEmail => {
		const send = vi.fn().mockResolvedValue({ messageId: 'cf-id' });
		await emailService.sendByCloudflareEmail({ env: { email: { send } } }, message({ accountEmail }));
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0][0].from).toEqual({ email: accountEmail, name: 'alice' });
	});

	it.each(['alice@example.com', 'any.other@example.com'])('Resend receives actual account %s, not a fixed administrator From', async accountEmail => {
		await emailService.sendByResend('test-placeholder-token', message({ accountEmail }));
		expect(resendSend).toHaveBeenCalledOnce();
		expect(resendSend.mock.calls[0][0].from).toBe(`alice <${accountEmail}>`);
	});
});
