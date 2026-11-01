import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfigValue } from '../../src/util.js';
import { serverDirectory } from '../../src/server-directory.js';
import {
    COMMON_DATASETS,
    buildSelection,
    defaultUserWireToLocal,
    isCommonWirePath,
    planEntriesInScope,
    scanCommonManifest,
    scanWireSubtree,
    wireToLocal,
} from './manifest.js';
import {
    TTSyncClient,
    createDeviceIdentity,
    parsePairUri,
} from './ttsync-client.js';
import {
    PERSONA_SELECTION_IDS,
    PERSONA_STATE_WIRE_PATH,
    PRESETS_WIRE_PATH,
    SETTINGS_WIRE_PATH,
    STATE_SELECTION_IDS,
    USER_AVATARS_WIRE_ROOT,
    mergeDownloadState,
    mergeUploadState,
} from './state-sync.js';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DATA_DIR = path.join(PLUGIN_DIR, 'data');
const CONFIG_PATH = path.join(PLUGIN_DATA_DIR, 'config.json');
const BACKUP_DIR = path.join(PLUGIN_DATA_DIR, 'backups');
const TEMP_DIR = path.join(PLUGIN_DATA_DIR, 'tmp');
const DATA_ROOT = path.resolve(serverDirectory, String(getConfigValue('dataRoot', './data')));
const LOCAL_SETTINGS_PATH = path.join(DATA_ROOT, 'default-user', 'settings.json');
const LOCAL_USER_AVATARS_ROOT = path.join(DATA_ROOT, 'default-user', 'User Avatars');
const MAX_BACKUPS = 5;
const TRANSFER_CONCURRENCY = 4;

let currentJob = null;

function publicConfig(config) {
    if (!config) return null;
    return {
        url: config.url,
        spki: config.spki,
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        pairedAt: config.pairedAt,
        serverDeviceId: config.serverDeviceId ?? null,
        serverDeviceName: config.serverDeviceName ?? null,
        permissions: config.permissions ?? null,
    };
}

function createJob(direction, mode) {
    return {
        running: true,
        direction,
        mode,
        phase: 'starting',
        filesTotal: 0,
        filesDone: 0,
        bytesTotal: 0,
        bytesDone: 0,
        filesDeleted: 0,
        currentPath: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        summary: null,
        backupPath: null,
        logs: [],
    };
}

function logJob(job, message) {
    const line = String(message);
    job.logs.push({ at: new Date().toISOString(), message: line });
    if (job.logs.length > 200) job.logs.shift();
    console.log(`[tt-sync-bridge] ${line}`);
}

async function readConfig() {
    try {
        return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function writeConfig(config) {
    await fs.mkdir(PLUGIN_DATA_DIR, { recursive: true, mode: 0o700 });
    const temp = `${CONFIG_PATH}.tmp-${process.pid}`;
    await fs.writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
    await fs.rename(temp, CONFIG_PATH);
}

async function removeConfig() {
    await fs.rm(CONFIG_PATH, { force: true });
}

function createClient(config) {
    return new TTSyncClient(config, console);
}

async function mapLimit(items, limit, mapper) {
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
        while (true) {
            const current = index++;
            if (current >= items.length) return;
            await mapper(items[current], current);
        }
    });
    await Promise.all(workers);
}

async function pruneBackups() {
    let dirs;
    try {
        dirs = (await fs.readdir(BACKUP_DIR, { withFileTypes: true }))
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort()
            .reverse();
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }

    for (const dir of dirs.slice(MAX_BACKUPS)) {
        await fs.rm(path.join(BACKUP_DIR, dir), { recursive: true, force: true });
    }
}

async function snapshotLocalCommonData(job, label) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(BACKUP_DIR, `${timestamp}-${label}`);
    let copied = 0;

    for (const wireRoot of [...new Set(COMMON_DATASETS.flatMap(dataset => dataset.roots))]) {
        const source = wireToLocal(DATA_ROOT, wireRoot);
        const target = path.join(destination, 'data', ...wireRoot.split('/'));
        try {
            await fs.access(source);
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.cp(source, target, {
            recursive: true,
            force: true,
            preserveTimestamps: true,
            errorOnExist: false,
        });
        copied++;
    }

    try {
        await fs.access(LOCAL_SETTINGS_PATH);
        const settingsTarget = path.join(destination, 'data', 'default-user', 'settings.json');
        await fs.mkdir(path.dirname(settingsTarget), { recursive: true });
        await fs.copyFile(LOCAL_SETTINGS_PATH, settingsTarget);
        copied++;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }

    try {
        await fs.access(LOCAL_USER_AVATARS_ROOT);
        const avatarTarget = path.join(destination, 'data', 'default-user', 'User Avatars');
        await fs.mkdir(path.dirname(avatarTarget), { recursive: true });
        await fs.cp(LOCAL_USER_AVATARS_ROOT, avatarTarget, {
            recursive: true,
            force: true,
            preserveTimestamps: true,
            errorOnExist: false,
        });
        copied++;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }

    if (copied === 0) return null;
    await fs.writeFile(path.join(destination, 'backup.json'), JSON.stringify({
        createdAt: new Date().toISOString(),
        dataRoot: DATA_ROOT,
        datasets: COMMON_DATASETS.map(dataset => dataset.id),
    }, null, 2));
    await pruneBackups();
    job.backupPath = destination;
    logJob(job, `已备份当前 ST 通用数据到 ${destination}`);
    return destination;
}

function mapLocalPath(wirePath) {
    return wireToLocal(DATA_ROOT, wirePath);
}

async function readJson(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function writeJsonAtomic(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.ttsync-state.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
        await fs.writeFile(temp, JSON.stringify(value, null, 4), { mode: 0o600 });
        await fs.rename(temp, filePath);
    } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
    }
}

async function makeTempDir(prefix) {
    const dir = path.join(TEMP_DIR, `${prefix}-${crypto.randomUUID()}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
}

async function pullRemoteState(client, status) {
    const selection = buildSelection(status, [...STATE_SELECTION_IDS, ...PERSONA_SELECTION_IDS]);
    let plan = null;
    const tempDir = await makeTempDir('state-pull');
    const result = { settings: null, presets: null, personaState: null };

    try {
        plan = await client.pullPlan('incremental', selection, { entries: [] });
        const wanted = new Map([
            [SETTINGS_WIRE_PATH, { key: 'settings', file: 'settings.json' }],
            [PRESETS_WIRE_PATH, { key: 'presets', file: 'presets.json' }],
            [PERSONA_STATE_WIRE_PATH, { key: 'personaState', file: 'persona-state.json' }],
        ]);

        for (const entry of plan.transfer) {
            const target = wanted.get(entry.path);
            if (!target) continue;
            const localPath = path.join(tempDir, target.file);
            await client.downloadFile(plan.plan_id, entry, localPath);
            result[target.key] = JSON.parse(await fs.readFile(localPath, 'utf8'));
        }

        await client.abortPlan(plan.plan_id);
        plan = null;
        return result;
    } finally {
        if (plan?.plan_id) await client.abortPlan(plan.plan_id).catch(() => {});
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function pushRemoteState(client, status, settings, presets) {
    const selection = buildSelection(status, STATE_SELECTION_IDS);
    const tempDir = await makeTempDir('state-push');
    let plan = null;

    try {
        const files = [
            { wirePath: SETTINGS_WIRE_PATH, fileName: 'settings.json', data: settings },
            { wirePath: PRESETS_WIRE_PATH, fileName: 'presets.json', data: presets },
        ];
        const entries = [];
        const localByWirePath = new Map();

        for (const file of files) {
            const localPath = path.join(tempDir, file.fileName);
            await fs.writeFile(localPath, JSON.stringify(file.data, null, 4), { mode: 0o600 });
            const stat = await fs.stat(localPath);
            entries.push({
                path: file.wirePath,
                size_bytes: stat.size,
                modified_ms: Math.trunc(stat.mtimeMs),
            });
            localByWirePath.set(file.wirePath, localPath);
        }

        plan = await client.pushPlan('incremental', selection, { entries });
        let transferred = 0;
        for (const entry of plan.transfer) {
            const localPath = localByWirePath.get(entry.path);
            if (!localPath) continue;
            await client.uploadFile(plan.plan_id, entry, localPath);
            transferred++;
        }
        await client.commitPush(plan.plan_id);
        plan = null;
        return transferred;
    } finally {
        if (plan?.plan_id) await client.abortPlan(plan.plan_id).catch(() => {});
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function syncPersonaUpload(job, client, status, personaState) {
    const selection = buildSelection(status, PERSONA_SELECTION_IDS);
    const tempDir = await makeTempDir('persona-push');
    let plan = null;

    try {
        const avatars = await scanWireSubtree(DATA_ROOT, USER_AVATARS_WIRE_ROOT);
        const personaPath = path.join(tempDir, 'persona-state.json');
        await fs.writeFile(personaPath, JSON.stringify(personaState, null, 4), { mode: 0o600 });
        const personaStat = await fs.stat(personaPath);
        const entries = [
            ...avatars.entries,
            {
                path: PERSONA_STATE_WIRE_PATH,
                size_bytes: personaStat.size,
                modified_ms: Math.trunc(personaStat.mtimeMs),
            },
        ];

        const localByWirePath = new Map();
        for (const entry of avatars.entries) {
            localByWirePath.set(entry.path, defaultUserWireToLocal(DATA_ROOT, entry.path));
        }
        localByWirePath.set(PERSONA_STATE_WIRE_PATH, personaPath);

        plan = await client.pushPlan(job.mode, selection, { entries });
        let transferred = 0;
        for (const entry of plan.transfer) {
            const localPath = localByWirePath.get(entry.path);
            if (!localPath) continue;
            await client.uploadFile(plan.plan_id, entry, localPath);
            transferred++;
        }
        const deletions = Array.isArray(plan.delete) ? plan.delete.length : 0;
        await client.commitPush(plan.plan_id);
        plan = null;
        logJob(job, `用户设定管理已上传：头像/状态 ${transferred} 个文件，镜像删除 ${deletions} 个`);
        return { transferred, deletions };
    } finally {
        if (plan?.plan_id) await client.abortPlan(plan.plan_id).catch(() => {});
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function syncPersonaDownload(job, client, status) {
    const selection = buildSelection(status, PERSONA_SELECTION_IDS);
    let plan = null;

    try {
        const localManifest = await scanWireSubtree(DATA_ROOT, USER_AVATARS_WIRE_ROOT);
        plan = await client.pullPlan(job.mode, selection, localManifest);

        const avatarTransfers = plan.transfer.filter(entry => entry.path.startsWith(`${USER_AVATARS_WIRE_ROOT}/`));
        let transferred = 0;
        await mapLimit(avatarTransfers, TRANSFER_CONCURRENCY, async entry => {
            const localPath = defaultUserWireToLocal(DATA_ROOT, entry.path);
            await client.downloadFile(plan.plan_id, entry, localPath);
            transferred++;
        });

        let deleted = 0;
        if (job.mode === 'mirror') {
            for (const wirePath of plan.delete ?? []) {
                if (!wirePath.startsWith(`${USER_AVATARS_WIRE_ROOT}/`)) continue;
                const localPath = defaultUserWireToLocal(DATA_ROOT, wirePath);
                await fs.rm(localPath, { force: true });
                deleted++;
            }
        }

        await client.abortPlan(plan.plan_id);
        plan = null;
        logJob(job, `用户设定管理已下载：头像 ${transferred} 个文件，镜像删除 ${deleted} 个`);
        return { transferred, deleted };
    } finally {
        if (plan?.plan_id) await client.abortPlan(plan.plan_id).catch(() => {});
    }
}

async function syncStateUpload(job, client, status) {
    job.phase = 'state';
    const localSettings = await readJson(LOCAL_SETTINGS_PATH);
    if (!localSettings) {
        logJob(job, '没有找到 ST settings.json，跳过预设/用户设置/酒馆助手状态同步');
        return { persona: { transferred: 0, deletions: 0 } };
    }

    const remote = await pullRemoteState(client, status);
    const { settings, presets, personaState } = mergeUploadState(
        localSettings,
        remote.settings ?? {},
        remote.presets ?? {},
        job.mode,
    );
    const transferred = await pushRemoteState(client, status, settings, presets);
    const persona = await syncPersonaUpload(job, client, status, personaState);
    logJob(job, `预设状态、用户设置、正则和酒馆助手全局脚本已合并上传（${transferred} 个状态文件发生更新）`);
    return { persona };
}

async function syncStateDownload(job, client, status) {
    job.phase = 'state';
    const remote = await pullRemoteState(client, status);
    const persona = await syncPersonaDownload(job, client, status);

    if (!remote.settings && !remote.presets && !remote.personaState) {
        logJob(job, 'TT-Sync 没有找到预设/用户设置/酒馆助手状态文件，跳过状态合并');
        return { stateUpdated: false, persona };
    }

    const localSettings = (await readJson(LOCAL_SETTINGS_PATH)) ?? {};
    const merged = mergeDownloadState(
        localSettings,
        remote.settings ?? {},
        remote.presets ?? {},
        job.mode,
        remote.personaState,
    );
    await writeJsonAtomic(LOCAL_SETTINGS_PATH, merged);
    logJob(job, '已合并 TT-Sync 的预设、用户设置、正则、用户设定和酒馆助手全局脚本到 ST settings.json');
    return { stateUpdated: true, persona };
}

async function deleteLocalPaths(paths, job) {
    for (const wirePath of paths) {
        if (!isCommonWirePath(wirePath)) {
            logJob(job, `跳过范围外删除：${wirePath}`);
            continue;
        }
        const localPath = mapLocalPath(wirePath);
        await fs.rm(localPath, { force: true });
        job.filesDeleted++;
        logJob(job, `已删除本地文件：${wirePath}`);
    }
}

async function runUpload(job, config, mode) {
    const client = createClient(config);
    let plan = null;
    try {
        const status = await client.status();
        const selection = buildSelection(status);
        logJob(job, `已连接 TT-Sync：${status.device_name || 'unknown'}，准备上传`);
        await client.ensureSession();

        job.phase = 'scanning';
        const sourceManifest = await scanCommonManifest(DATA_ROOT);
        job.filesTotal = sourceManifest.entries.length;
        logJob(job, `ST 通用数据扫描完成：${sourceManifest.entries.length} 个文件`);

        job.phase = 'comparing';
        plan = await client.pushPlan(mode, selection, sourceManifest);
        const transfer = planEntriesInScope(plan.transfer);
        const deletes = planEntriesInScope((plan.delete || []).map(item => ({ path: item })));
        job.filesTotal = transfer.length;
        job.bytesTotal = transfer.reduce((sum, entry) => sum + Number(entry.size_bytes), 0);
        logJob(job, `上传计划：传输 ${transfer.length} 个文件，${job.bytesTotal} 字节；镜像删除 ${deletes.length} 个文件`);

        job.phase = 'uploading';
        await mapLimit(transfer, TRANSFER_CONCURRENCY, async entry => {
            job.currentPath = entry.path;
            await client.uploadFile(plan.plan_id, entry, mapLocalPath(entry.path));
            job.filesDone++;
            job.bytesDone += Number(entry.size_bytes);
            logJob(job, `已上传：${entry.path}`);
        });

        job.phase = 'committing';
        job.currentPath = null;
        await client.commitPush(plan.plan_id);
        job.filesDeleted = deletes.length;
        logJob(job, 'TT-Sync 已提交上传计划');
        await syncStateUpload(job, client, status);
        job.summary = {
            direction: 'upload',
            mode,
            filesTransferred: transfer.length,
            bytesTransferred: job.bytesDone,
            filesDeleted: deletes.length,
        };
        plan = null;
    } finally {
        if (plan?.plan_id) {
            await client.abortPlan(plan.plan_id).catch(error => logJob(job, `中止计划失败：${error.message}`));
        }
        client.close();
    }
}

async function runDownload(job, config, mode) {
    const client = createClient(config);
    let plan = null;
    try {
        const status = await client.status();
        const selection = buildSelection(status);
        logJob(job, `已连接 TT-Sync：${status.device_name || 'unknown'}，准备下载`);
        await client.ensureSession();

        job.phase = 'backup';
        await snapshotLocalCommonData(job, `before-${mode}-download`);

        job.phase = 'scanning';
        const targetManifest = await scanCommonManifest(DATA_ROOT);
        logJob(job, `ST 通用数据扫描完成：${targetManifest.entries.length} 个文件`);

        job.phase = 'comparing';
        plan = await client.pullPlan(mode, selection, targetManifest);
        const transfer = planEntriesInScope(plan.transfer);
        const deletes = mode === 'mirror'
            ? planEntriesInScope((plan.delete || []).map(item => ({ path: item })))
            : [];
        job.filesTotal = transfer.length;
        job.bytesTotal = transfer.reduce((sum, entry) => sum + Number(entry.size_bytes), 0);
        logJob(job, `下载计划：传输 ${transfer.length} 个文件，${job.bytesTotal} 字节；镜像删除 ${deletes.length} 个本地文件`);

        job.phase = 'downloading';
        await mapLimit(transfer, TRANSFER_CONCURRENCY, async entry => {
            job.currentPath = entry.path;
            await client.downloadFile(plan.plan_id, entry, mapLocalPath(entry.path));
            job.filesDone++;
            job.bytesDone += Number(entry.size_bytes);
            logJob(job, `已下载：${entry.path}`);
        });

        if (mode === 'mirror' && deletes.length > 0) {
            job.phase = 'deleting';
            job.currentPath = null;
            await deleteLocalPaths(deletes.map(entry => entry.path), job);
        }

        job.currentPath = null;
        await client.abortPlan(plan.plan_id).catch(() => {});
        plan = null;
        const stateResult = await syncStateDownload(job, client, status);
        job.summary = {
            direction: 'download',
            mode,
            filesTransferred: transfer.length,
            bytesTransferred: job.bytesDone,
            filesDeleted: job.filesDeleted,
            backupPath: job.backupPath,
            stateUpdated: stateResult.stateUpdated,
            personaFilesTransferred: stateResult.persona?.transferred ?? 0,
            personaFilesDeleted: stateResult.persona?.deleted ?? 0,
        };
        logJob(job, '下载/恢复完成');
    } finally {
        if (plan?.plan_id) {
            await client.abortPlan(plan.plan_id).catch(error => logJob(job, `中止计划失败：${error.message}`));
        }
        client.close();
    }
}

async function runSync(job, config) {
    try {
        if (job.direction === 'upload') {
            await runUpload(job, config, job.mode);
        } else {
            await runDownload(job, config, job.mode);
        }
    } catch (error) {
        job.error = error?.message || String(error);
        logJob(job, `同步失败：${job.error}`);
    } finally {
        job.running = false;
        job.phase = job.error ? 'failed' : 'completed';
        job.finishedAt = new Date().toISOString();
        job.currentPath = null;
    }
}

async function init(router) {
    await fs.mkdir(PLUGIN_DATA_DIR, { recursive: true, mode: 0o700 });

    router.get('/status', async (req, res) => {
        const config = await readConfig();
        const payload = {
            ok: true,
            dataRoot: DATA_ROOT,
            datasets: COMMON_DATASETS.map(dataset => dataset.id),
            config: publicConfig(config),
            connected: false,
            server: null,
            error: null,
            job: currentJob,
        };

        if (config) {
            const client = createClient(config);
            try {
                const status = await client.status();
                await client.ensureSession();
                payload.connected = true;
                payload.server = {
                    protocol: status.protocol,
                    server: status.server,
                    features: status.features,
                    deviceId: status.device_id,
                    deviceName: status.device_name,
                    spkiSha256: status.spki_sha256,
                    supportedProfiles: status.supported_profile_ids,
                };
            } catch (error) {
                payload.error = error?.message || String(error);
            } finally {
                client.close();
            }
        }

        res.json(payload);
    });

    router.post('/pair', async (req, res) => {
        if (currentJob?.running) {
            return res.status(409).json({ ok: false, error: '同步任务正在运行，暂时不能重新配对' });
        }

        try {
            const pairUri = String(req.body?.pairUri ?? '').trim();
            if (!pairUri) return res.status(400).json({ ok: false, error: '请填写 TT-Sync 配对链接' });

            const pair = parsePairUri(pairUri);
            const oldConfig = await readConfig();
            const identity = oldConfig && oldConfig.url === pair.url && oldConfig.spki === pair.spki
                ? {
                    deviceId: oldConfig.deviceId,
                    deviceSeed: oldConfig.deviceSeed,
                    devicePublicKey: oldConfig.devicePublicKey,
                }
                : createDeviceIdentity();

            const candidate = {
                version: 1,
                url: pair.url,
                spki: pair.spki,
                ...identity,
                deviceName: 'SillyTavern',
            };

            const client = createClient(candidate);
            try {
                const pairResponse = await client.pair(pair.token, identity);
                const status = await client.status();
                candidate.pairedAt = new Date().toISOString();
                candidate.serverDeviceId = status.device_id ?? pairResponse.server_device_id ?? null;
                candidate.serverDeviceName = status.device_name ?? pairResponse.server_device_name ?? null;
                candidate.permissions = pairResponse.granted_permissions ?? null;
                await writeConfig(candidate);
                await client.ensureSession();
                res.json({
                    ok: true,
                    config: publicConfig(candidate),
                    server: {
                        deviceId: status.device_id,
                        deviceName: status.device_name,
                        protocol: status.protocol,
                        features: status.features,
                    },
                });
            } finally {
                client.close();
            }
        } catch (error) {
            res.status(500).json({ ok: false, error: error?.message || String(error) });
        }
    });

    router.post('/sync', async (req, res) => {
        if (currentJob?.running) {
            return res.status(409).json({ ok: false, error: '已有同步任务正在运行' });
        }

        const direction = String(req.body?.direction ?? '');
        const mode = String(req.body?.mode ?? 'incremental');
        const confirmMirror = req.body?.confirmMirror === true;

        if (!['upload', 'download'].includes(direction)) {
            return res.status(400).json({ ok: false, error: 'direction 必须是 upload 或 download' });
        }
        if (!['incremental', 'mirror'].includes(mode)) {
            return res.status(400).json({ ok: false, error: 'mode 必须是 incremental 或 mirror' });
        }
        if (mode === 'mirror' && !confirmMirror) {
            return res.status(400).json({ ok: false, error: '镜像模式需要二次确认' });
        }

        const config = await readConfig();
        if (!config) return res.status(400).json({ ok: false, error: '还没有配对 TT-Sync' });

        currentJob = createJob(direction, mode);
        void runSync(currentJob, config);
        res.status(202).json({ ok: true, job: currentJob });
    });

    router.get('/job', (req, res) => {
        res.json({ ok: true, job: currentJob });
    });

    router.post('/reset', async (req, res) => {
        if (currentJob?.running) {
            return res.status(409).json({ ok: false, error: '同步任务正在运行，无法重置配对' });
        }
        await removeConfig();
        res.json({ ok: true });
    });
}

async function exit() {
    currentJob = null;
}

export {
    init,
    exit,
};

export const info = {
    id: 'tt-sync-bridge',
    name: 'TT-Sync Bridge',
    description: 'Connect SillyTavern to an existing TT-Sync v2 workspace with a conservative common-data profile.',
};
