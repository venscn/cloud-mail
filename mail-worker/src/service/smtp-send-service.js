import { WorkerMailer } from 'worker-mailer';
import kvConst from '../const/kv-const';
import fileUtils from '../utils/file-utils';

// 渠道每日配额默认值，可通过环境变量 sendpulse_daily_limit / resend_daily_limit / qq_daily_limit 覆盖
const DAILY_LIMITS = {
	sendpulse: 400,
	resend: 100,
	qq: 100
};

// SMTP 渠道默认连接配置（Workers 出站 25 端口被封，只用 465/587）
const SMTP_DEFAULTS = {
	sendpulse: { host: 'smtp-pulse.com', port: 465, secure: true, startTls: false },
	qq: { host: 'smtp.qq.com', port: 465, secure: true, startTls: false }
};

// 配额计数写入 KV 的过期时间：两天自动过期，无需清理
const QUOTA_TTL = 172800;

const smtpSendService = {

	// 取渠道当日配额上限：系统设置 dailyLimit > 环境变量 > 内置默认
	getDailyLimit(c, channel, smtpChannels) {
		const settingValue = Number(smtpChannels?.[channel]?.dailyLimit);
		if (Number.isFinite(settingValue) && settingValue > 0) {
			return Math.floor(settingValue);
		}
		const envValue = Number(c.env[`${channel}_daily_limit`]);
		return Number.isFinite(envValue) && envValue > 0 ? Math.floor(envValue) : DAILY_LIMITS[channel];
	},

	// 配额 KV 键：send_quota:<channel>:<UTC yyyy-mm-dd>
	quotaKey(channel) {
		return `${kvConst.SEND_QUOTA}${channel}:${new Date().toISOString().slice(0, 10)}`;
	},

	// 查询渠道当日已用配额（按收件人数计，to+cc+bcc 都算）
	async getQuotaUsed(c, channel) {
		const used = await c.env.kv.get(this.quotaKey(channel));
		return Number(used) || 0;
	},

	// 查询渠道当日配额余量
	async getQuotaRemaining(c, channel, limit) {
		return Math.max(0, limit - await this.getQuotaUsed(c, channel));
	},

	// 发送成功后按实际收件人数递增配额计数
	async incrQuota(c, channel, count) {
		const used = await this.getQuotaUsed(c, channel) + count;
		await c.env.kv.put(this.quotaKey(channel), String(used), { expirationTtl: QUOTA_TTL });
	},

	// 配额/频率限制类错误时把当日计数直接设为上限，标记该渠道今日不可用
	async markQuotaExhausted(c, channel, limit) {
		await c.env.kv.put(this.quotaKey(channel), String(limit), { expirationTtl: QUOTA_TTL });
	},

	// 匹配 429、quota、rate limit、limit exceeded 等配额/频率限制类错误信息
	isQuotaError(error) {
		const message = String(error?.message || error || '').toLowerCase();
		return /\b429\b|quota|rate[\s_-]*limit|limit exceeded|too many|throttl/.test(message);
	},

	// 读取 SMTP 渠道配置：优先系统设置 smtpChannels，环境变量（兼容旧部署）按字段后备。
	// user+pass 都配置了才算可用，未配置返回 null
	getSmtpConfig(c, channel, smtpChannels) {
		const settingConf = smtpChannels?.[channel] || {};
		const user = settingConf.user || c.env[`${channel}_smtp_user`];
		const pass = settingConf.pass || c.env[`${channel}_smtp_pass`];
		if (!user || !pass) {
			return null;
		}
		const defaults = SMTP_DEFAULTS[channel];
		return {
			host: settingConf.host || c.env[`${channel}_smtp_host`] || defaults.host,
			port: Number(settingConf.port) || Number(c.env[`${channel}_smtp_port`]) || defaults.port,
			secure: defaults.secure,
			startTls: defaults.startTls,
			credentials: { username: user, password: pass },
			authType: ['plain', 'login']
		};
	},

	// SMTP 发送：fromEmail 为 MAIL FROM 地址（QQ 必须传 QQ 账号本身，其余渠道传发件账号地址）
	// worker-mailer 的 send 不返回 messageId，providerId 统一存 null
	async sendBySmtp(config, params, fromEmail) {
		const sendForm = {
			from: { email: fromEmail, name: params.name },
			to: [...params.receiveEmail],
			subject: params.subject
		};

		// QQ 等渠道 From 必须是渠道账号本身，用 Reply-To 指回真实发件人，收件人回复会回到其 @域名 地址
		if (fromEmail !== params.accountEmail) {
			sendForm.reply = params.accountEmail;
		}

		if (params.ccEmail.length > 0) {
			sendForm.cc = [...params.ccEmail];
		}

		if (params.bccEmail.length > 0) {
			sendForm.bcc = [...params.bccEmail];
		}

		if (params.text) {
			sendForm.text = params.text;
		}

		if (params.html) {
			sendForm.html = params.html;
		}

		const attachments = await this.toMailerAttachments(params.attachments);
		if (attachments.length > 0) {
			sendForm.attachments = attachments;
		}

		if (params.sendType === 'reply' && params.messageId) {
			sendForm.headers = {
				'in-reply-to': params.messageId,
				'references': params.messageId
			};
		}

		const mailer = await WorkerMailer.connect(config);
		try {
			await mailer.send(sendForm);
		} finally {
			await mailer.close().catch(() => {});
		}

		return { data: { id: null } };
	},

	// 映射为 worker-mailer 附件格式：filename + base64 content + mimeType
	// 注意：worker-mailer 不支持 contentId，内嵌图片会降级为普通附件
	async toMailerAttachments(attachments = []) {
		const result = [];

		for (const attachment of attachments) {
			const content = await this.toAttachmentBase64(attachment);
			if (!content) {
				continue;
			}

			result.push({
				filename: attachment.filename,
				content,
				mimeType: attachment.mimeType || attachment.contentType || attachment.type || 'application/octet-stream'
			});
		}

		return result;
	},

	async toAttachmentBase64(attachment) {
		let content = attachment.content;

		if (!content) {
			return null;
		}

		if (typeof content === 'string') {
			if (content.startsWith('data:')) {
				content = content.split(',')[1] || content;
			}
			return content.replace(/\s+/g, '');
		}

		const arrayBuffer = await this.toAttachmentArrayBuffer(attachment);
		if (!arrayBuffer) {
			return null;
		}

		const bytes = new Uint8Array(arrayBuffer);
		let binary = '';

		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}

		return btoa(binary);
	},

	async toAttachmentArrayBuffer(attachment) {
		let content = attachment.content;

		if (!content) {
			return null;
		}

		if (content instanceof ArrayBuffer) {
			return content;
		}

		if (content instanceof Uint8Array) {
			return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
		}

		if (typeof content === 'string') {
			if (content.startsWith('data:')) {
				content = content.split(',')[1] || content;
			}
			return fileUtils.base64ToUint8Array(content.replace(/\s+/g, '')).buffer;
		}

		return content;
	}
};

export default smtpSendService;
