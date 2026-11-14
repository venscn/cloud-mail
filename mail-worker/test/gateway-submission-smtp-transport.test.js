import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerMailer } from 'worker-mailer';
import smtpSendService from '../src/service/smtp-send-service';
import { setSocketFactory } from './helpers/synthetic-smtp-sockets';

const socketConnect = vi.fn();
setSocketFactory(socketConnect);

// Only the TCP/TLS socket boundary is replaced. The installed worker-mailer
// 1.3.1 state machine, response parser, recipient loop and DATA completion run
// unchanged on real Web Streams. No network connection can be opened.
function smtpPeer({ recipients = ['250 recipient accepted'], final = '250 queued' } = {}) {
	const commands = [];
	const body = [];
	let input = '';
	let data = false;
	let recipientIndex = 0;
	let controller;
	let closed = false;
	let finishData;
	const dataFinished = new Promise(resolve => { finishData = resolve; });
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const reply = text => controller.enqueue(encoder.encode(`${text}\r\n`));
	const readable = new ReadableStream({ start(value) { controller = value; reply('220 synthetic.example.test ESMTP'); } });
	const writable = new WritableStream({
		async write(bytes) {
			input += decoder.decode(bytes, { stream: true });
			let end;
			while ((end = input.indexOf('\r\n')) !== -1) {
				const line = input.slice(0, end);
				input = input.slice(end + 2);
				if (data) {
					if (line === '.') {
						data = false;
						finishData();
						reply(typeof final === 'function' ? await final() : final);
					} else { body.push(line); }
					continue;
				}
				commands.push(line);
				if (/^EHLO |^HELO /.test(line)) reply('250-synthetic.example.test\r\n250 AUTH PLAIN');
				else if (line.startsWith('AUTH PLAIN')) reply('235 authenticated');
				else if (line.startsWith('MAIL FROM:')) reply('250 sender accepted');
				else if (line.startsWith('RCPT TO:')) reply(recipients[recipientIndex++] || '550 unexpected recipient');
				else if (line === 'DATA') { data = true; reply('354 end with dot'); }
				else if (line === 'RSET') reply('250 reset');
				else if (line === 'QUIT') reply('221 bye');
				else throw new Error(`Unexpected SMTP command: ${line}`);
			}
		}
	});
	const socket = {
		readable, writable, opened: Promise.resolve({}),
		async close() { if (!closed) { closed = true; controller.close(); } }
	};
	socketConnect.mockReturnValue(socket);
	return { commands, body, dataFinished, get closed() { return closed; } };
}

const config = {
	host: 'synthetic.example.test', port: 465, secure: true, startTls: false,
	credentials: { username: 'synthetic@example.test', password: 'synthetic-test-password' },
	authType: 'plain', logLevel: 4, responseTimeoutMs: 1000, socketTimeoutMs: 1000
};
const message = recipients => ({
	name: 'aLiCe', accountEmail: 'alice@example.test', receiveEmail: recipients,
	ccEmail: [], bccEmail: [], subject: 'Synthetic SMTP state-machine regression',
	text: 'No real message is sent.', attachments: []
});

beforeEach(() => socketConnect.mockReset());

describe('real worker-mailer SMTP all-recipient acceptance boundary', () => {
	it('accepts only after the real library observes the final DATA 250', async () => {
		expect(vi.isMockFunction(WorkerMailer.connect)).toBe(false);
		let release;
		const finalReply = new Promise(resolve => { release = resolve; });
		const peer = smtpPeer({ final: () => finalReply });
		let settled = false;
		const sending = smtpSendService.sendBySendPulse(config, message(['one@external.test']));
		sending.then(() => { settled = true; }, () => { settled = true; });
		await peer.dataFinished;
		expect(settled).toBe(false);
		release('250 queued');
		await expect(sending).resolves.toEqual({ data: { id: null } });
		expect(peer.commands.filter(value => value.startsWith('RCPT TO:'))).toHaveLength(1);
		expect(peer.commands).toContain('DATA');
		expect(peer.body.join('\r\n')).toContain('Subject: Synthetic SMTP state-machine regression');
		expect(socketConnect).toHaveBeenCalledTimes(1);
		expect(peer.closed).toBe(true);
	});

	it('rejects RCPT 550 and never reaches DATA', async () => {
		const peer = smtpPeer({ recipients: ['550 no such recipient'] });
		await expect(smtpSendService.sendBySendPulse(config, message(['missing@external.test']))).rejects.toThrow(/550/);
		expect(peer.commands).not.toContain('DATA');
		expect(peer.body).toHaveLength(0);
	});

	it('rejects final-DATA 451 instead of reporting acceptance', async () => {
		const peer = smtpPeer({ final: '451 temporary processing failure' });
		await expect(smtpSendService.sendBySendPulse(config, message(['one@external.test']))).rejects.toThrow(/451/);
		expect(peer.commands).toContain('DATA');
		expect(peer.body.length).toBeGreaterThan(0);
	});

	it('does not treat mixed RCPT 250/550 as all-recipient acceptance', async () => {
		const peer = smtpPeer({ recipients: ['250 first recipient accepted', '550 second recipient rejected'] });
		await expect(smtpSendService.sendBySendPulse(config, message(['one@external.test', 'two@external.test']))).rejects.toThrow(/550/);
		expect(peer.commands.filter(value => value.startsWith('RCPT TO:'))).toHaveLength(2);
		expect(peer.commands).not.toContain('DATA');
		expect(peer.body).toHaveLength(0);
	});

	it('also preserves RCPT rejection for the QQ delegation adapter', async () => {
		const peer = smtpPeer({ recipients: ['550 recipient rejected'] });
		await expect(smtpSendService.sendByQq(config, message(['missing@external.test']))).rejects.toThrow(/550/);
		expect(peer.commands).not.toContain('DATA');
	});
});
