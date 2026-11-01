import fs from 'node:fs/promises';
import path from 'node:path';

export const DATASET_POLICY_VERSION = 1;

/**
 * The deliberately conservative intersection used by this bridge.
 * TT-only datasets, settings, secrets, extensions and backup archives are
 * intentionally excluded so that mirror mode cannot touch them.
 */
export const COMMON_DATASETS = Object.freeze([
    { id: 'chat.character.history', roots: ['default-user/chats'] },
    { id: 'chat.group.metadata', roots: ['default-user/groups'] },
    { id: 'chat.group.history', roots: ['default-user/group chats'] },
    { id: 'character.cards', roots: ['default-user/characters'] },
    { id: 'world.info', roots: ['default-user/worlds'] },
    { id: 'preset.openai', roots: ['default-user/OpenAI Settings'] },
    { id: 'preset.novelai', roots: ['default-user/NovelAI Settings'] },
    { id: 'preset.textgen', roots: ['default-user/TextGen Settings'] },
    { id: 'preset.kobold', roots: ['default-user/KoboldAI Settings'] },
    { id: 'prompt.instruct', roots: ['default-user/instruct'] },
    { id: 'prompt.context', roots: ['default-user/context'] },
    { id: 'prompt.sysprompt', roots: ['default-user/sysprompt'] },
    { id: 'prompt.reasoning', roots: ['default-user/reasoning'] },
    { id: 'quick.replies', roots: ['default-user/QuickReplies'] },
    { id: 'ui.themes', roots: ['default-user/themes'] },
    { id: 'ui.moving', roots: ['default-user/movingUI'] },
    { id: 'media.backgrounds', roots: ['default-user/backgrounds'] },
    { id: 'media.assets', roots: ['default-user/assets'] },
    { id: 'media.thumbnails', roots: ['default-user/thumbnails'] },
    { id: 'media.user_images', roots: ['default-user/user/images'] },
    { id: 'user.files', roots: ['default-user/user/files'] },
    { id: 'user.workflows', roots: ['default-user/user/workflows'] },
    { id: 'vectors', roots: ['default-user/vectors'] },
]);

const COMMON_ROOTS = [...new Set(COMMON_DATASETS.flatMap(dataset => dataset.roots))];

export function buildSelection(status, datasetIds = COMMON_DATASETS.map(dataset => dataset.id)) {
    const policyVersion = Number(status?.dataset_policy_version ?? DATASET_POLICY_VERSION);
    if (policyVersion !== DATASET_POLICY_VERSION) {
        throw new Error(`TT-Sync 数据集策略版本不支持：${policyVersion}`);
    }

    const supported = new Set(Array.isArray(status?.supported_dataset_ids) ? status.supported_dataset_ids : []);
    const missing = datasetIds.filter(id => !supported.has(id));
    if (missing.length > 0) {
        throw new Error(`TT-Sync 不支持以下数据集：${missing.join(', ')}`);
    }

    return {
        policy_version: policyVersion,
        dataset_ids: [...datasetIds],
    };
}

export function isExcludedWirePath(wirePath) {
    return String(wirePath)
        .split('/')
        .some(part => part === '.staging' || part.startsWith('.tmp-') || part.endsWith('.ttsync.tmp'));
}

function assertSafeWirePath(wirePath) {
    if (typeof wirePath !== 'string' || wirePath.length === 0 || wirePath.startsWith('/') || wirePath.includes('\\')) {
        throw new Error(`非法同步路径：${wirePath}`);
    }
    for (const part of wirePath.split('/')) {
        if (!part || part === '.' || part === '..' || part.includes('\0')) {
            throw new Error(`非法同步路径：${wirePath}`);
        }
    }
}

export function isCommonWirePath(wirePath) {
    assertSafeWirePath(wirePath);
    return COMMON_ROOTS.some(root => wirePath === root || wirePath.startsWith(`${root}/`));
}

export function wireToLocal(dataRoot, wirePath) {
    assertSafeWirePath(wirePath);
    if (!isCommonWirePath(wirePath)) {
        throw new Error(`路径不在通用数据集范围内：${wirePath}`);
    }

    const root = path.resolve(dataRoot);
    const full = path.resolve(root, ...wirePath.split('/'));
    if (full !== root && !full.startsWith(root + path.sep)) {
        throw new Error(`同步路径越界：${wirePath}`);
    }
    return full;
}

export function defaultUserWireToLocal(dataRoot, wirePath) {
    assertSafeWirePath(wirePath);
    if (!wirePath.startsWith('default-user/')) {
        throw new Error(`路径不在 default-user 范围内：${wirePath}`);
    }

    const root = path.resolve(dataRoot);
    const full = path.resolve(root, ...wirePath.split('/'));
    if (full !== root && !full.startsWith(root + path.sep)) {
        throw new Error(`同步路径越界：${wirePath}`);
    }
    return full;
}

async function scanDirectory(dataRoot, wireRoot, localDir, entries) {
    let directoryEntries;
    try {
        directoryEntries = await fs.readdir(localDir, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }

    directoryEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of directoryEntries) {
        const localPath = path.join(localDir, entry.name);
        const wirePath = `${wireRoot}/${entry.name}`;

        if (isExcludedWirePath(wirePath)) continue;
        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
            await scanDirectory(dataRoot, wirePath, localPath, entries);
            continue;
        }

        if (!entry.isFile()) continue;

        const stat = await fs.stat(localPath);
        entries.push({
            path: wirePath,
            size_bytes: stat.size,
            modified_ms: Math.trunc(stat.mtimeMs),
        });
    }
}

export async function scanWireSubtree(dataRoot, wireRoot) {
    assertSafeWirePath(wireRoot);
    if (!wireRoot.startsWith('default-user/')) {
        throw new Error(`只允许扫描 default-user 路径：${wireRoot}`);
    }

    const entries = [];
    const localRoot = defaultUserWireToLocal(dataRoot, wireRoot);
    let stat;
    try {
        stat = await fs.stat(localRoot);
    } catch (error) {
        if (error?.code === 'ENOENT') return { entries };
        throw error;
    }
    if (stat.isDirectory()) {
        await scanDirectory(dataRoot, wireRoot, localRoot, entries);
    } else if (stat.isFile()) {
        entries.push({
            path: wireRoot,
            size_bytes: stat.size,
            modified_ms: Math.trunc(stat.mtimeMs),
        });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { entries };
}

export async function scanCommonManifest(dataRoot) {
    const entries = [];

    for (const wireRoot of COMMON_ROOTS) {
        const localRoot = wireToLocal(dataRoot, wireRoot);
        let stat;
        try {
            stat = await fs.stat(localRoot);
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        if (!stat.isDirectory()) continue;
        await scanDirectory(dataRoot, wireRoot, localRoot, entries);
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { entries };
}

export function planEntriesInScope(entries) {
    return (Array.isArray(entries) ? entries : []).filter(entry => {
        try {
            return isCommonWirePath(entry.path) && !isExcludedWirePath(entry.path);
        } catch {
            return false;
        }
    });
}
