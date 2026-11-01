import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { pipeline } from 'node:stream/promises';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class TTSyncRequestError extends Error {
    constructor(message, status = 0, body = '') {
        super(message);
        this.name = 'TTSyncRequestError';
        this.status = status;
        this.body = body;
    }
}

function sha256Base64Url(value) {
    return crypto.createHash('sha256').update(value).digest('base64url');
}

function validateHttpsOrigin(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('TT-Sync 地址不是合法 URL');
    }
    if (url.protocol !== 'https:') throw new Error('TT-Sync 地址必须是 https://');
    if (url.username || url.password || url.search || url.hash) throw new Error('TT-Sync 地址不能包含账号、查询参数或片段');
    if (url.pathname !== '/' && url.pathname !== '') throw new Error('TT-Sync 地址不能包含路径');
    return url.origin;
}

function privateKeyFromSeed(seedBase64Url) {
    const seed = Buffer.from(String(seedBase64Url), 'base64url');
    if (seed.length !== 32) throw new Error('TT-Sync Ed25519 seed 必须是 32 字节');
    return crypto.createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
        format: 'der',
        type: 'pkcs8',
    });
}

export function createDeviceIdentity() {
    const seed = crypto.randomBytes(32);
    const privateKey = privateKeyFromSeed(seed.toString('base64url'));
    const publicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
    return {
        deviceId: crypto.randomUUID(),
        deviceSeed: seed.toString('base64url'),
        devicePublicKey: publicJwk.x,
    };
}

export function parsePairUri(pairUri) {
    const text = String(pairUri ?? '').trim();
    const prefix = 'tauritavern://tt-sync/pair?';
    if (!text.startsWith(prefix)) {
        throw new Error('请填写 TT-Sync 生成的一对一配对链接（tauritavern://tt-sync/pair?...）');
    }

    const params = new URLSearchParams(text.slice(prefix.length));
    if (params.get('v') !== '2') throw new Error('不支持的 TT-Sync 配对链接版本');
    const url = validateHttpsOrigin(params.get('url') ?? '');
    const token = String(params.get('token') ?? '').trim();
    const spki = String(params.get('spki') ?? '').trim();
    const exp = Number(params.get('exp') ?? 0);
    if (!token) throw new Error('配对链接缺少 token');
    if (!spki) throw new Error('配对链接缺少 SPKI pin');
    if (!Number.isFinite(exp) || exp <= 0) throw new Error('配对链接缺少有效期');
    if (Date.now() > exp) throw new Error('配对链接已过期，请在 TT-Sync 重新生成');

    return { url, token, spki, expiresAtMs: exp };
}

class PinnedHttpsAgent extends https.Agent {
    constructor(expectedSpki) {
        super({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 });
        this.expectedSpki = String(expectedSpki);
    }

    createConnection(options, callback) {
        let settled = false;
        const finish = (error, socket) => {
            if (settled) return;
            settled = true;
            callback(error, socket);
        };

        const socket = tls.connect({ ...options, rejectUnauthorized: false });
        socket.once('error', error => finish(error));
        socket.once('secureConnect', () => {
            try {
                const certificate = socket.getPeerCertificate(true);
                if (!certificate?.raw) throw new Error('TT-Sync 没有返回 TLS 证书');
                const x509 = new crypto.X509Certificate(certificate.raw);
                const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' });
                const actual = crypto.createHash('sha256').update(spkiDer).digest('base64url');
                if (actual !== this.expectedSpki) {
                    throw new Error(`TT-Sync TLS SPKI 不匹配：${actual}`);
                }
                finish(null, socket);
            } catch (error) {
                socket.destroy();
                finish(error);
            }
        });
    }
}

export class TTSyncClient {
    constructor(config, logger = console) {
        this.origin = validateHttpsOrigin(config.url);
        this.spki = String(config.spki);
        this.deviceId = String(config.deviceId);
        this.deviceSeed = String(config.deviceSeed);
        this.deviceName = String(config.deviceName || 'SillyTavern');
        this.logger = logger;
        this.agent = new PinnedHttpsAgent(this.spki);
        this.privateKey = privateKeyFromSeed(this.deviceSeed);
        this.sessionToken = null;
        this.sessionExpiresAt = 0;
        this.sessionPromise = null;
    }

    close() {
        this.agent.destroy();
    }

    endpoint(pathname) {
        return new URL(pathname, `${this.origin}/`).toString();
    }

    async jsonRequest(pathname, { method = 'GET', headers = {}, body = null } = {}) {
        const payload = body == null ? null : Buffer.from(JSON.stringify(body));
        const requestHeaders = { ...headers };
        if (payload) {
            requestHeaders['Content-Type'] = 'application/json';
            requestHeaders['Content-Length'] = String(payload.length);
        }

        return await new Promise((resolve, reject) => {
            const request = https.request(this.endpoint(pathname), {
                method,
                agent: this.agent,
                headers: requestHeaders,
            }, response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        let message = text;
                        try {
                            const parsed = JSON.parse(text);
                            message = parsed.error || parsed.message || text;
                        } catch { /* keep raw */ }
                        reject(new TTSyncRequestError(`TT-Sync 请求失败（HTTP ${response.statusCode}）：${message}`, response.statusCode, text));
                        return;
                    }
                    if (!text) return resolve({});
                    try {
                        resolve(JSON.parse(text));
                    } catch {
                        reject(new TTSyncRequestError('TT-Sync 返回了非 JSON 响应', response.statusCode, text));
                    }
                });
            });
            request.on('error', reject);
            if (payload) request.write(payload);
            request.end();
        });
    }

    async status() {
        return await this.jsonRequest('/v2/status');
    }

    async pair(token, identity) {
        return await this.jsonRequest(`/v2/pair/complete?token=${encodeURIComponent(token)}`, {
            method: 'POST',
            body: {
                device_id: identity.deviceId,
                device_name: this.deviceName,
                device_pubkey: identity.devicePublicKey,
            },
        });
    }

    async openSession() {
        const body = Buffer.from(JSON.stringify({ device_id: this.deviceId }));
        const timestamp = Date.now();
        const nonce = crypto.randomBytes(12).toString('base64url');
        const bodyHash = sha256Base64Url(body);
        const canonical = `TT-SYNC-V2\n${this.deviceId}\n${timestamp}\n${nonce}\nPOST\n/v2/session/open\n${bodyHash}`;
        const signature = crypto.sign(null, Buffer.from(canonical), this.privateKey).toString('base64url');

        const response = await new Promise((resolve, reject) => {
            const request = https.request(this.endpoint('/v2/session/open'), {
                method: 'POST',
                agent: this.agent,
                headers: {
                    'TT-Device-Id': this.deviceId,
                    'TT-Timestamp-Ms': String(timestamp),
                    'TT-Nonce': nonce,
                    'TT-Signature': signature,
                    'Content-Type': 'application/json',
                    'Content-Length': String(body.length),
                },
            }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new TTSyncRequestError(`TT-Sync 会话打开失败（HTTP ${res.statusCode}）：${text}`, res.statusCode, text));
                        return;
                    }
                    try {
                        resolve(JSON.parse(text));
                    } catch {
                        reject(new TTSyncRequestError('TT-Sync 会话响应不是 JSON', res.statusCode, text));
                    }
                });
            });
            request.on('error', reject);
            request.write(body);
            request.end();
        });

        this.sessionToken = response.session_token;
        this.sessionExpiresAt = Number(response.expires_at_ms || 0);
        return response;
    }

    async ensureSession() {
        if (this.sessionToken && this.sessionExpiresAt > Date.now() + 30000) {
            return this.sessionToken;
        }
        if (!this.sessionPromise) {
            this.sessionPromise = this.openSession()
                .finally(() => { this.sessionPromise = null; });
        }
        await this.sessionPromise;
        return this.sessionToken;
    }

    async authenticatedJson(pathname, { method = 'GET', body = null, retry = true } = {}) {
        const token = await this.ensureSession();
        try {
            return await this.jsonRequest(pathname, {
                method,
                body,
                headers: { Authorization: `Bearer ${token}` },
            });
        } catch (error) {
            if (retry && error instanceof TTSyncRequestError && error.status === 401) {
                this.sessionToken = null;
                this.sessionExpiresAt = 0;
                return await this.authenticatedJson(pathname, { method, body, retry: false });
            }
            throw error;
        }
    }

    async pullPlan(mode, selection, targetManifest) {
        return await this.authenticatedJson('/v2/sync/pull-plan', {
            method: 'POST',
            body: {
                mode: mode === 'mirror' ? 'Mirror' : 'Incremental',
                overwrite_policy: 'exact',
                selection,
                target_manifest: targetManifest,
            },
        });
    }

    async pushPlan(mode, selection, sourceManifest) {
        return await this.authenticatedJson('/v2/sync/push-plan', {
            method: 'POST',
            body: {
                mode: mode === 'mirror' ? 'Mirror' : 'Incremental',
                overwrite_policy: 'exact',
                selection,
                source_manifest: sourceManifest,
            },
        });
    }

    pathSegment(syncPath) {
        return Buffer.from(syncPath, 'utf8').toString('base64url');
    }

    async downloadFile(planId, entry, targetPath) {
        const token = await this.ensureSession();
        const url = this.endpoint(`/v2/plans/${encodeURIComponent(planId)}/files/${this.pathSegment(entry.path)}`);
        const tempPath = `${targetPath}.ttsync.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        await fsp.mkdir(path.dirname(targetPath), { recursive: true });

        try {
            await new Promise((resolve, reject) => {
                const request = https.request(url, {
                    method: 'GET',
                    agent: this.agent,
                    headers: { Authorization: `Bearer ${token}` },
                }, response => {
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        const chunks = [];
                        response.on('data', chunk => chunks.push(chunk));
                        response.on('end', () => reject(new TTSyncRequestError(
                            `TT-Sync 下载失败（HTTP ${response.statusCode}）：${Buffer.concat(chunks).toString('utf8')}`,
                            response.statusCode,
                        )));
                        return;
                    }

                    const contentLength = Number(response.headers['content-length']);
                    if (Number.isFinite(contentLength) && contentLength !== Number(entry.size_bytes)) {
                        reject(new Error(`下载长度不一致：${entry.path}`));
                        response.destroy();
                        return;
                    }

                    const writeStream = fs.createWriteStream(tempPath, { flags: 'wx' });
                    pipeline(response, writeStream).then(resolve, reject);
                });
                request.on('error', reject);
                request.end();
            });

            await fsp.utimes(tempPath, new Date(), new Date(Number(entry.modified_ms)));
            await fsp.rename(tempPath, targetPath);
        } catch (error) {
            await fsp.rm(tempPath, { force: true }).catch(() => {});
            throw error;
        }
    }

    async uploadFile(planId, entry, sourcePath) {
        const stat = await fsp.stat(sourcePath);
        if (!stat.isFile()) throw new Error(`上传源不是文件：${entry.path}`);
        if (stat.size !== Number(entry.size_bytes)) {
            throw new Error(`上传前文件大小已变化，请重新同步：${entry.path}`);
        }

        const token = await this.ensureSession();
        const url = this.endpoint(`/v2/plans/${encodeURIComponent(planId)}/files/${this.pathSegment(entry.path)}`);

        await new Promise((resolve, reject) => {
            const request = https.request(url, {
                method: 'PUT',
                agent: this.agent,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': String(stat.size),
                },
            }, response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        reject(new TTSyncRequestError(`TT-Sync 上传失败（HTTP ${response.statusCode}）：${text}`, response.statusCode, text));
                        return;
                    }
                    resolve();
                });
            });
            request.on('error', reject);
            pipeline(fs.createReadStream(sourcePath), request).catch(reject);
        });
    }

    async commitPush(planId) {
        return await this.authenticatedJson(`/v2/plans/${encodeURIComponent(planId)}/commit`, { method: 'POST' });
    }

    async abortPlan(planId) {
        return await this.authenticatedJson(`/v2/plans/${encodeURIComponent(planId)}`, { method: 'DELETE' });
    }
}
