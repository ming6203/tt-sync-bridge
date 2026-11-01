/**
 * Selective state bridge between TauriTavern and SillyTavern.
 *
 * This module never replaces a whole settings.json. It merges only the
 * state needed for presets, user settings, personas, Tavern Helper scripts,
 * regex scripts and their global variables. Incremental mode preserves
 * target-only entries where the data is list/object based; mirror mode makes
 * the source side authoritative.
 */

export const SETTINGS_WIRE_PATH = 'default-user/settings.json';
export const PRESETS_WIRE_PATH = 'default-user/settings/presets.json';
export const PERSONA_STATE_WIRE_PATH = 'default-user/settings/persona-state.json';
export const USER_AVATARS_WIRE_ROOT = 'default-user/User Avatars';
export const STATE_SELECTION_IDS = Object.freeze(['settings.core', 'settings.presets']);
export const PERSONA_SELECTION_IDS = Object.freeze(['character.avatars']);

export const PRESET_STATE_KEYS = Object.freeze([
    'oai_settings',
    'textgenerationwebui_settings',
    'kai_settings',
    'nai_settings',
    'horde_settings',
    'main_api',
    'max_context',
    'amount_gen',
]);

export const PRESET_POWER_KEYS = Object.freeze([
    'context',
    'instruct',
    'reasoning',
    'sysprompt',
]);

export const PERSONA_POWER_KEYS = Object.freeze([
    'default_persona',
    'persona_description',
    'persona_description_depth',
    'persona_description_lorebook',
    'persona_description_position',
    'persona_description_role',
    'persona_show_notifications',
    'persona_sort_order',
    'personas',
    'persona_descriptions',
]);

const EXTENSION_SETTING_EXCLUSIONS = new Set([
    'apiKey',
    'apiUrl',
]);

const REGEX_STATE_KEYS = new Set([
    'regex',
    'regex_presets',
    'character_allowed_regex',
    'preset_allowed_regex',
    'regexBinding_scriptId',
]);

const TAVERN_HELPER_STATE_KEYS = new Set([
    'tavern_helper',
    'variables',
]);

export const DEFAULT_STATE_OPTIONS = Object.freeze({
    presetState: true,
    userSettings: true,
    persona: true,
    extensionSettings: true,
    tavernHelper: true,
    regex: true,
    apiKeys: false,
});

function effectiveStateOptions(options) {
    return { ...DEFAULT_STATE_OPTIONS, ...(options ?? {}) };
}

function shouldMergeExtensionKey(key, options) {
    if (key === 'apiKey' || key === 'apiUrl') return options.apiKeys;
    if (REGEX_STATE_KEYS.has(key)) return options.regex;
    if (TAVERN_HELPER_STATE_KEYS.has(key)) return options.tavernHelper;
    return options.extensionSettings;
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueKey(item) {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && item.id !== undefined) return `id:${item.id}`;
    return JSON.stringify(item);
}

function mergeUniqueArrays(target, source) {
    const result = [];
    const seen = new Set();
    for (const item of [...(Array.isArray(target) ? target : []), ...(Array.isArray(source) ? source : [])]) {
        const key = uniqueKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(clone(item));
    }
    return result;
}

function mergeArrayById(target, source, mergeObject = false) {
    if (!Array.isArray(source)) return clone(source);
    if (!Array.isArray(target)) return clone(source);

    const result = clone(target);
    const indexById = new Map();
    result.forEach((item, index) => {
        if (item?.id !== undefined) indexById.set(String(item.id), index);
    });

    for (const sourceItem of source) {
        const id = sourceItem?.id;
        if (id !== undefined && indexById.has(String(id))) {
            const index = indexById.get(String(id));
            result[index] = mergeObject
                ? deepMergeObject(result[index], sourceItem)
                : clone(sourceItem);
        } else {
            result.push(clone(sourceItem));
            if (id !== undefined) indexById.set(String(id), result.length - 1);
        }
    }
    return result;
}

function mergeScriptObject(target, source) {
    const merged = { ...(isPlainObject(target) ? clone(target) : {}), ...clone(source) };
    if (Array.isArray(target?.scripts) || Array.isArray(source?.scripts)) {
        merged.scripts = mergeScriptTrees(target?.scripts, source?.scripts);
    }
    return merged;
}

function mergeScriptTrees(target, source) {
    const result = Array.isArray(target) ? clone(target) : [];
    const indexById = new Map();
    result.forEach((item, index) => {
        if (item?.id !== undefined) indexById.set(String(item.id), index);
    });

    for (const sourceItem of Array.isArray(source) ? source : []) {
        const id = sourceItem?.id;
        if (id !== undefined && indexById.has(String(id))) {
            const index = indexById.get(String(id));
            result[index] = mergeScriptObject(result[index], sourceItem);
        } else {
            result.push(clone(sourceItem));
            if (id !== undefined) indexById.set(String(id), result.length - 1);
        }
    }
    return result;
}

function mergeScriptState(target, source) {
    const merged = { ...(isPlainObject(target) ? clone(target) : {}) };
    for (const [key, value] of Object.entries(source ?? {})) {
        if (key === 'scripts') {
            merged.scripts = mergeScriptTrees(target?.scripts, value);
        } else if (key === 'enabled' || key === 'popuped') {
            const previous = isPlainObject(target?.[key]) ? target[key] : {};
            merged[key] = { ...clone(previous), ...clone(value) };
            for (const arrayKey of ['presets', 'characters']) {
                if (Array.isArray(previous?.[arrayKey]) || Array.isArray(value?.[arrayKey])) {
                    merged[key][arrayKey] = mergeUniqueArrays(previous?.[arrayKey], value?.[arrayKey]);
                }
            }
        } else {
            merged[key] = clone(value);
        }
    }
    return merged;
}

function deepMergeObject(target, source) {
    const result = isPlainObject(target) ? clone(target) : {};
    for (const [key, value] of Object.entries(source ?? {})) {
        result[key] = isPlainObject(result[key]) && isPlainObject(value)
            ? deepMergeObject(result[key], value)
            : clone(value);
    }
    return result;
}

function mergePresetAllowedRegex(target, source) {
    const result = isPlainObject(target) ? clone(target) : {};
    for (const [key, value] of Object.entries(source ?? {})) {
        result[key] = Array.isArray(result[key]) && Array.isArray(value)
            ? mergeUniqueArrays(result[key], value)
            : clone(value);
    }
    return result;
}

function mergeExtensionValue(key, target, source, mode) {
    if (mode === 'mirror') {
        if (key === 'regex' || key === 'regex_presets') return clone(source);
        if (key === 'character_allowed_regex') return clone(source);
        if (key === 'preset_allowed_regex') return clone(source);
        if (key === 'regexBinding_scriptId') return clone(source);
        return clone(source);
    }

    switch (key) {
        case 'tavern_helper': {
            const merged = isPlainObject(target) ? clone(target) : {};
            for (const [field, value] of Object.entries(source ?? {})) {
                merged[field] = field === 'script'
                    ? mergeScriptState(merged.script, value)
                    : isPlainObject(merged[field]) && isPlainObject(value)
                        ? deepMergeObject(merged[field], value)
                        : clone(value);
            }
            return merged;
        }
        case 'regex':
            return mergeArrayById(target, source, true);
        case 'regex_presets':
            return mergeArrayById(target, source, true);
        case 'character_allowed_regex':
            return mergeUniqueArrays(target, source);
        case 'preset_allowed_regex':
            return mergePresetAllowedRegex(target, source);
        case 'regexBinding_scriptId':
            return clone(source);
        case 'variables':
        default:
            if (isPlainObject(target) && isPlainObject(source)) {
                return deepMergeObject(target, source);
            }
            return clone(source);
    }
}

function mergeExtensionSettings(target, source, mode, options) {
    const result = isPlainObject(target) ? clone(target) : {};
    for (const [key, value] of Object.entries(source ?? {})) {
        if (!shouldMergeExtensionKey(key, options)) continue;
        result[key] = mergeExtensionValue(key, result[key], value, mode);
    }
    return result;
}

/**
 * Merge TT-Sync state into the current ST settings.
 * @param {object} localSettings Current SillyTavern settings.json
 * @param {object} remoteSettings TT-Sync default-user/settings.json
 * @param {object} remotePresets TT-Sync default-user/settings/presets.json
 * @param {'incremental'|'mirror'} mode Sync mode
 * @param {object|null} remotePersonaState TT-Sync default-user/settings/persona-state.json
 * @returns {object} New settings object, localSettings is not mutated
 */
export function mergeDownloadState(localSettings, remoteSettings, remotePresets, mode = 'incremental', remotePersonaState = null, stateOptions = null) {
    const merged = clone(localSettings) ?? {};
    const options = effectiveStateOptions(stateOptions);

    if (options.userSettings && isPlainObject(remoteSettings?.power_user)) {
        merged.power_user = deepMergeObject(merged.power_user, remoteSettings.power_user);
    }

    const remoteExtensions = remoteSettings?.extension_settings;
    if (remoteExtensions && typeof remoteExtensions === 'object'
        && (options.extensionSettings || options.tavernHelper || options.regex || options.apiKeys)) {
        merged.extension_settings = mergeExtensionSettings(merged.extension_settings, remoteExtensions, mode, options);
    }

    if (options.apiKeys) {
        if (Object.hasOwn(remoteSettings ?? {}, 'proxies')) merged.proxies = clone(remoteSettings.proxies);
        if (Object.hasOwn(remoteSettings ?? {}, 'selected_proxy')) merged.selected_proxy = clone(remoteSettings.selected_proxy);
    }

    if (options.presetState && remotePresets && typeof remotePresets === 'object') {
        for (const key of PRESET_STATE_KEYS) {
            if (Object.hasOwn(remotePresets, key)) {
                merged[key] = clone(remotePresets[key]);
            }
        }

        if (remotePresets.power_user && typeof remotePresets.power_user === 'object') {
            merged.power_user ??= {};
            for (const key of PRESET_POWER_KEYS) {
                if (Object.hasOwn(remotePresets.power_user, key)) {
                    merged.power_user[key] = clone(remotePresets.power_user[key]);
                }
            }
        }
    }

    if (options.persona && isPlainObject(remotePersonaState)) {
        merged.power_user ??= {};
        if (isPlainObject(remotePersonaState.power_user)) {
            merged.power_user = deepMergeObject(merged.power_user, remotePersonaState.power_user);
        }
        if (Object.hasOwn(remotePersonaState, 'username')) merged.username = clone(remotePersonaState.username);
        if (Object.hasOwn(remotePersonaState, 'user_avatar')) merged.user_avatar = clone(remotePersonaState.user_avatar);
    }

    return merged;
}

export function buildPersonaState(localSettings) {
    const personaState = {
        power_user: {},
        username: localSettings?.username ?? '',
        user_avatar: localSettings?.user_avatar ?? '',
    };
    for (const key of PERSONA_POWER_KEYS) {
        if (Object.hasOwn(localSettings?.power_user ?? {}, key)) {
            personaState.power_user[key] = clone(localSettings.power_user[key]);
        }
    }
    return personaState;
}

/**
 * Merge ST state into copies of TT-Sync's current files so unknown TT-only
 * fields are preserved.
 * @param {object} localSettings Current SillyTavern settings.json
 * @param {object} remoteSettings TT-Sync default-user/settings.json
 * @param {object} remotePresets TT-Sync default-user/settings/presets.json
 * @param {'incremental'|'mirror'} mode Sync mode
 * @returns {{settings: object, presets: object, personaState: object}}
 */
export function mergeUploadState(localSettings, remoteSettings, remotePresets, mode = 'incremental', stateOptions = null) {
    const settings = clone(remoteSettings) ?? {};
    const presets = clone(remotePresets) ?? {};
    const localExtensions = localSettings?.extension_settings;
    const options = effectiveStateOptions(stateOptions);

    if (options.userSettings && isPlainObject(localSettings?.power_user)) {
        settings.power_user = deepMergeObject(settings.power_user, localSettings.power_user);
    }

    if (localExtensions && typeof localExtensions === 'object'
        && (options.extensionSettings || options.tavernHelper || options.regex || options.apiKeys)) {
        settings.extension_settings = mergeExtensionSettings(settings.extension_settings, localExtensions, mode, options);
    }

    if (options.apiKeys) {
        if (Object.hasOwn(localSettings ?? {}, 'proxies')) settings.proxies = clone(localSettings.proxies);
        if (Object.hasOwn(localSettings ?? {}, 'selected_proxy')) settings.selected_proxy = clone(localSettings.selected_proxy);
    }

    if (options.presetState) {
        for (const key of PRESET_STATE_KEYS) {
            if (Object.hasOwn(localSettings ?? {}, key)) {
                presets[key] = clone(localSettings[key]);
            }
        }

        if (localSettings?.power_user && typeof localSettings.power_user === 'object') {
            presets.power_user ??= {};
            for (const key of PRESET_POWER_KEYS) {
                if (Object.hasOwn(localSettings.power_user, key)) {
                    presets.power_user[key] = clone(localSettings.power_user[key]);
                }
            }
        }
    }

    return { settings, presets, personaState: buildPersonaState(localSettings) };
}
