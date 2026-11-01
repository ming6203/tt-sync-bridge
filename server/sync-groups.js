export const SYNC_GROUPS = Object.freeze([
    {
        id: 'chats',
        label: '聊天记录',
        description: '角色聊天记录 chats/',
        datasets: ['chat.character.history'],
        defaultEnabled: true,
    },
    {
        id: 'groups',
        label: '群组与群聊',
        description: '群组元数据和群聊记录',
        datasets: ['chat.group.metadata', 'chat.group.history'],
        defaultEnabled: true,
    },
    {
        id: 'characters',
        label: '角色卡',
        description: '角色卡文件和角色卡目录',
        datasets: ['character.cards'],
        defaultEnabled: true,
    },
    {
        id: 'worldinfo',
        label: '世界书',
        description: '世界书 / lorebook',
        datasets: ['world.info'],
        defaultEnabled: true,
    },
    {
        id: 'presets',
        label: '模型与生成预设',
        description: 'OpenAI、NovelAI、TextGen、Kobold 预设及当前预设状态',
        datasets: ['preset.openai', 'preset.novelai', 'preset.textgen', 'preset.kobold'],
        state: ['presetState'],
        defaultEnabled: true,
    },
    {
        id: 'prompts',
        label: '提示词与推理预设',
        description: 'instruct / context / sysprompt / reasoning',
        datasets: ['prompt.instruct', 'prompt.context', 'prompt.sysprompt', 'prompt.reasoning'],
        defaultEnabled: true,
    },
    {
        id: 'quickreplies',
        label: '快速回复',
        description: 'Quick Replies',
        datasets: ['quick.replies'],
        defaultEnabled: true,
    },
    {
        id: 'ui',
        label: '主题与界面',
        description: '主题、movingUI 和界面资源',
        datasets: ['ui.themes', 'ui.moving'],
        defaultEnabled: true,
    },
    {
        id: 'media',
        label: '媒体与用户文件',
        description: '背景、assets、缩略图、用户图片、文件和工作流',
        datasets: ['media.backgrounds', 'media.assets', 'media.thumbnails', 'media.user_images', 'user.files', 'user.workflows'],
        defaultEnabled: true,
    },
    {
        id: 'vectors',
        label: 'Vectors 向量数据',
        description: '向量索引和向量文件',
        datasets: ['vectors'],
        defaultEnabled: true,
    },
    {
        id: 'personas',
        label: '用户头像与 Persona 设定',
        description: 'User Avatars、persona-state 和 persona 字段',
        datasets: ['character.avatars'],
        special: 'persona',
        state: ['persona'],
        defaultEnabled: true,
    },
    {
        id: 'extensions',
        label: '扩展本体与扩展数据',
        description: '全局第三方扩展、用户扩展目录及扩展设置',
        datasets: ['extensions.local', 'extensions.third_party'],
        special: 'extensions',
        state: ['extensionSettings'],
        defaultEnabled: true,
    },
    {
        id: 'tavernHelper',
        label: '酒馆助手脚本与全局变量',
        description: 'Tavern Helper / JS-Slash-Runner 脚本和 variables',
        state: ['tavernHelper'],
        defaultEnabled: true,
    },
    {
        id: 'regex',
        label: '正则脚本与正则预设',
        description: '全局 regex、regex_presets 和允许列表',
        state: ['regex'],
        defaultEnabled: true,
    },
    {
        id: 'userSettings',
        label: '用户设置 power_user',
        description: 'SillyTavern 用户偏好和界面设置',
        state: ['userSettings'],
        defaultEnabled: true,
    },
    {
        id: 'apiKeys',
        label: 'API、密钥与代理相关设置',
        description: 'secrets.json、extension apiKey/apiUrl、Reverse Proxy、proxies 和 selected_proxy（默认关闭）',
        datasets: ['secrets.api_keys'],
        special: 'apiKeys',
        state: ['apiKeys'],
        defaultEnabled: false,
    },
]);

export const DEFAULT_SYNC_GROUP_IDS = SYNC_GROUPS
    .filter(group => group.defaultEnabled)
    .map(group => group.id);

export function publicSyncGroups() {
    return SYNC_GROUPS.map(group => ({
        id: group.id,
        label: group.label,
        description: group.description,
        defaultEnabled: group.defaultEnabled,
    }));
}

export function resolveSyncGroups(status, selectedIds) {
    const requested = Array.isArray(selectedIds) && selectedIds.length > 0
        ? new Set(selectedIds)
        : new Set(DEFAULT_SYNC_GROUP_IDS);
    const groups = SYNC_GROUPS.filter(group => requested.has(group.id));
    if (groups.length === 0) throw new Error('至少需要勾选一项同步内容');

    const supported = new Set(Array.isArray(status?.supported_dataset_ids) ? status.supported_dataset_ids : []);
    const mainDatasets = [];
    const specialDatasets = { persona: [], extensions: [], apiKeys: [] };
    const state = {
        presetState: false,
        userSettings: false,
        persona: false,
        extensionSettings: false,
        tavernHelper: false,
        regex: false,
        apiKeys: false,
    };

    for (const group of groups) {
        const datasets = Array.isArray(group.datasets) ? group.datasets : [];
        if (group.special && specialDatasets[group.special]) {
            specialDatasets[group.special].push(...datasets);
        } else {
            mainDatasets.push(...datasets);
        }
        for (const key of group.state ?? []) state[key] = true;
    }

    const allDatasets = [...new Set([
        ...mainDatasets,
        ...specialDatasets.persona,
        ...specialDatasets.extensions,
        ...specialDatasets.apiKeys,
    ])];
    const missing = allDatasets.filter(id => !supported.has(id));
    if (missing.length > 0) throw new Error(`TT-Sync 不支持以下数据集：${missing.join(', ')}`);

    return {
        groupIds: groups.map(group => group.id),
        mainDatasets: [...new Set(mainDatasets)],
        specialDatasets,
        state,
    };
}
