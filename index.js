import { getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { getRequestHeaders } from '../../../../script.js';

const API_BASE = '/api/plugins/tt-sync-bridge';
const SYNC_GROUPS_STORAGE_KEY = 'tt_sync_bridge_selected_groups_v1';
const SYNC_MODE_STORAGE_KEY = 'tt_sync_bridge_sync_mode_v1';
let pollTimer = null;
let busy = false;
let syncGroups = [];
let defaultGroups = [];
let selectedGroups = new Set();
let groupsInitialized = false;

function ui() {
    return {
        status: document.querySelector('#tt_sync_connection_status'),
        serverInfo: document.querySelector('#tt_sync_server_info'),
        pairUri: document.querySelector('#tt_sync_pair_uri'),
        pairButton: document.querySelector('#tt_sync_pair_btn'),
        disconnectButton: document.querySelector('#tt_sync_disconnect_btn'),
        mode: document.querySelector('#tt_sync_mode'),
        modeHelp: document.querySelector('#tt_sync_mode_help'),
        scopeButton: document.querySelector('#tt_sync_scope_btn'),
        scopeModal: document.querySelector('#tt_sync_scope_modal'),
        scopeList: document.querySelector('#tt_sync_scope_list'),
        scopeAll: document.querySelector('#tt_sync_scope_all'),
        scopeDefault: document.querySelector('#tt_sync_scope_default'),
        scopeCancel: document.querySelector('#tt_sync_scope_cancel'),
        scopeSave: document.querySelector('#tt_sync_scope_save'),
        uploadButton: document.querySelector('#tt_sync_upload_btn'),
        downloadButton: document.querySelector('#tt_sync_download_btn'),
        progress: document.querySelector('#tt_sync_progress'),
        progressText: document.querySelector('#tt_sync_progress_text'),
        log: document.querySelector('#tt_sync_log'),
    };
}

function explainApiError(response, data) {
    if (response.status === 404) {
        return new Error(
            '当前 SillyTavern 没有加载 TT-Sync 服务端插件。请将仓库 server/ 目录安装到 '
            + 'SillyTavern/plugins/tt-sync-bridge/，确认 config.yaml 中 enableServerPlugins: true，'
            + '然后重启 SillyTavern。',
        );
    }
    if (response.status === 401 || response.status === 403) {
        return new Error(data.error || 'SillyTavern 登录或权限校验失败，请重新登录后再试');
    }
    return new Error(data.error || `HTTP ${response.status}`);
}

async function apiGet(pathname) {
    const response = await fetch(`${API_BASE}${pathname}`, {
        method: 'GET',
        headers: getRequestHeaders(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw explainApiError(response, data);
    return data;
}

async function apiPost(pathname, body) {
    const response = await fetch(`${API_BASE}${pathname}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw explainApiError(response, data);
    return data;
}

function setBusy(value) {
    busy = value;
    for (const button of [ui().pairButton, ui().disconnectButton, ui().uploadButton, ui().downloadButton]) {
        if (button) button.disabled = value;
    }
}

function setStatus(text, type = '') {
    const el = ui().status;
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-ok', type === 'ok');
    el.classList.toggle('is-error', type === 'error');
}

function renderStatus(data) {
    const config = data.config;
    if (data.connected) {
        setStatus('已连接', 'ok');
        const serverName = data.server?.deviceName || config?.serverDeviceName || 'TT-Sync';
        const permissions = config?.permissions;
        const permissionText = permissions
            ? `读=${permissions.read ? '是' : '否'}，写=${permissions.write ? '是' : '否'}，镜像删除=${permissions.mirror_delete ? '是' : '否'}`
            : '未知';
        ui().serverInfo.textContent = `${serverName} | ${config?.url || ''} | 设备：${config?.deviceName || 'SillyTavern'} | ${permissionText}`;
    } else if (config) {
        setStatus('配对已保存，但连接失败', 'error');
        ui().serverInfo.textContent = data.error || '';
    } else {
        setStatus('未连接');
        ui().serverInfo.textContent = '请填入 TT-Sync 生成的一对一配对链接。';
    }
}

function loadStoredGroups() {
    try {
        const value = JSON.parse(localStorage.getItem(SYNC_GROUPS_STORAGE_KEY) || 'null');
        return Array.isArray(value) ? value.map(String) : null;
    } catch {
        return null;
    }
}

function initializeGroups(data) {
    if (!Array.isArray(data?.groups) || data.groups.length === 0) return;
    syncGroups = data.groups;
    defaultGroups = Array.isArray(data.defaultGroups) && data.defaultGroups.length > 0
        ? data.defaultGroups.map(String)
        : syncGroups.filter(group => group.defaultEnabled).map(group => group.id);

    if (!groupsInitialized) {
        const known = new Set(syncGroups.map(group => group.id));
        const stored = loadStoredGroups();
        const initial = (stored ?? defaultGroups).filter(id => known.has(id));
        selectedGroups = new Set(initial.length > 0 ? initial : defaultGroups);
        groupsInitialized = true;
    }
}

function renderScopeList() {
    const list = ui().scopeList;
    if (!list) return;
    list.replaceChildren();
    for (const group of syncGroups) {
        const label = document.createElement('label');
        label.className = 'tt-sync-scope-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.groupId = group.id;
        checkbox.checked = selectedGroups.has(group.id);

        const text = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = group.label;
        const description = document.createElement('small');
        description.textContent = group.description || '';
        text.append(title, description);

        label.append(checkbox, text);
        list.append(label);
    }
}

function openScopeModal() {
    renderScopeList();
    if (ui().scopeModal) ui().scopeModal.hidden = false;
}

function closeScopeModal() {
    if (ui().scopeModal) ui().scopeModal.hidden = true;
}

function saveScopeSelection() {
    const checked = [...ui().scopeList.querySelectorAll('input[type="checkbox"]:checked')]
        .map(input => input.dataset.groupId);
    if (checked.length === 0) {
        toastr.warning('至少需要勾选一项同步内容');
        return;
    }
    selectedGroups = new Set(checked);
    localStorage.setItem(SYNC_GROUPS_STORAGE_KEY, JSON.stringify(checked));
    closeScopeModal();
}

function selectScopeGroups(ids) {
    const known = new Set(syncGroups.map(group => group.id));
    selectedGroups = new Set(ids.filter(id => known.has(id)));
    renderScopeList();
}

function loadStoredSyncMode() {
    const value = localStorage.getItem(SYNC_MODE_STORAGE_KEY);
    return ['incremental', 'mirror'].includes(value) ? value : 'incremental';
}

function saveSyncMode(value) {
    if (['incremental', 'mirror'].includes(value)) {
        localStorage.setItem(SYNC_MODE_STORAGE_KEY, value);
    }
}

function renderModeHelp() {
    const mode = ui().mode?.value || 'incremental';
    ui().modeHelp.textContent = mode === 'mirror'
        ? '镜像模式：源端文件为准，会删除目标端在通用数据集中多余的文件。执行前会要求二次确认。'
        : '增量模式：对比文件，同步新增或变化的文件，不删除目标端多余文件。';
}

function renderJob(job) {
    if (!job) {
        ui().progress.value = 0;
        ui().progress.max = 1;
        ui().progressText.textContent = '空闲';
        return;
    }

    const total = Math.max(1, Number(job.filesTotal) || 1);
    const done = Math.min(total, Number(job.filesDone) || 0);
    ui().progress.max = total;
    ui().progress.value = done;
    const phase = job.phase || '';
    ui().progressText.textContent = job.running
        ? `${phase}：${done}/${Number(job.filesTotal) || 0} 文件，${Number(job.bytesDone) || 0}/${Number(job.bytesTotal) || 0} 字节${job.currentPath ? ` | ${job.currentPath}` : ''}`
        : (job.error ? `失败：${job.error}` : '完成');

    if (Array.isArray(job.logs)) {
        ui().log.textContent = job.logs.slice(-80).map(line => `[${new Date(line.at).toLocaleTimeString()}] ${line.message}`).join('\n');
        ui().log.scrollTop = ui().log.scrollHeight;
    }
}

async function refreshStatus() {
    try {
        const data = await apiGet('/status');
        initializeGroups(data);
        renderStatus(data);
        if (data.job) renderJob(data.job);
        if (data.job?.running) {
            setBusy(true);
            if (!pollTimer) pollJob();
        }
    } catch (error) {
        setStatus(`状态检查失败：${error.message}`, 'error');
    }
}

function stopPolling() {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
}

function showReloadOverlay() {
    if (document.querySelector('#tt_sync_reload_overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'tt_sync_reload_overlay';
    overlay.className = 'tt-sync-reload-overlay';
    overlay.innerHTML = `
        <div class="tt-sync-reload-card">
            <h3>同步完成</h3>
            <p>用户设定、角色卡、正则、扩展或预设已更新。页面将在 <strong id="tt_sync_reload_count">8</strong> 秒后自动刷新，避免旧页面把同步结果覆盖。</p>
            <button id="tt_sync_reload_now" class="menu_button">立即刷新</button>
        </div>
    `;
    document.body.append(overlay);

    let remaining = 8;
    const count = overlay.querySelector('#tt_sync_reload_count');
    const timer = window.setInterval(() => {
        remaining--;
        if (count) count.textContent = String(Math.max(0, remaining));
        if (remaining <= 0) {
            window.clearInterval(timer);
            window.location.reload();
        }
    }, 1000);

    overlay.querySelector('#tt_sync_reload_now')?.addEventListener('click', () => {
        window.clearInterval(timer);
        window.location.reload();
    });
}

async function pollJob() {
    stopPolling();
    try {
        const data = await apiGet('/job');
        renderJob(data.job);
        if (data.job?.running) {
            pollTimer = setTimeout(pollJob, 1000);
        } else {
            setBusy(false);
            await refreshStatus();
            if (data.job?.error) {
                toastr.error(data.job.error);
            } else if (data.job?.summary) {
                toastr.success('TT-Sync 同步完成');
                const summary = data.job.summary;
                const downloadChanged = data.job.direction === 'download' && (
                    Number(summary.filesTransferred) > 0
                    || Number(summary.filesDeleted) > 0
                    || Number(summary.personaFilesTransferred) > 0
                    || Number(summary.personaFilesDeleted) > 0
                    || Number(summary.extensionFilesTransferred) > 0
                    || Number(summary.apiFilesTransferred) > 0
                    || summary.apiKeysUpdated === true
                    || summary.stateUpdated === true
                );
                if (downloadChanged) {
                    showReloadOverlay();
                }
            }
        }
    } catch (error) {
        setBusy(false);
        toastr.error(error.message);
    }
}

async function startSync(direction) {
    if (busy) return;
    if (selectedGroups.size === 0) {
        toastr.warning('请先点击“选择同步内容”并至少勾选一项');
        return;
    }
    const mode = ui().mode?.value || 'incremental';
    const label = direction === 'upload' ? '上传 ST → TT-Sync' : '下载 TT-Sync → ST';

    if (mode === 'mirror') {
        const message = direction === 'upload'
            ? '镜像上传会以 ST 的通用数据集为准，删除 TT-Sync 上通用数据集中 ST 不存在的文件，包括多余的扩展目录（TT-Sync Bridge 自身除外）。确定继续？'
            : '镜像下载会以 TT-Sync 的通用数据集为准，删除 ST 中通用数据集里 TT-Sync 不存在的文件，包括多余的扩展目录（TT-Sync Bridge 自身除外）。确定继续？';
        if (!window.confirm(message)) return;
    }

    try {
        setBusy(true);
        const result = await apiPost('/sync', {
            direction,
            mode,
            groups: [...selectedGroups],
            confirmMirror: mode === 'mirror',
        });
        renderJob(result.job);
        toastr.info(`${label} 已开始`);
        pollJob();
    } catch (error) {
        setBusy(false);
        toastr.error(error.message);
    }
}

async function pair() {
    if (busy) return;
    const pairUri = String(ui().pairUri?.value || '').trim();
    if (!pairUri) {
        toastr.warning('请先填写 TT-Sync 配对链接');
        return;
    }

    try {
        setBusy(true);
        const result = await apiPost('/pair', { pairUri });
        ui().pairUri.value = '';
        toastr.success(`已连接到 ${result.server?.deviceName || 'TT-Sync'}`);
        await refreshStatus();
    } catch (error) {
        toastr.error(error.message);
    } finally {
        setBusy(false);
    }
}

async function disconnect() {
    if (busy) return;
    if (!window.confirm('只清除本插件保存的配对信息，不会撤销 TT-Sync 服务端的设备授权。继续？')) return;
    try {
        setBusy(true);
        await apiPost('/reset');
        await refreshStatus();
        toastr.success('本地配对信息已清除');
    } catch (error) {
        toastr.error(error.message);
    } finally {
        setBusy(false);
    }
}

export async function init() {
    const html = await renderExtensionTemplateAsync('third-party/tt-sync-bridge', 'settings');
    $('#extensions_settings2').append(html);

    const elements = ui();
    if (!elements.pairButton) return;

    elements.pairButton.addEventListener('click', pair);
    elements.disconnectButton.addEventListener('click', disconnect);
    elements.scopeButton.addEventListener('click', openScopeModal);
    elements.scopeAll.addEventListener('click', () => selectScopeGroups(syncGroups.map(group => group.id)));
    elements.scopeDefault.addEventListener('click', () => selectScopeGroups(defaultGroups));
    elements.scopeCancel.addEventListener('click', closeScopeModal);
    elements.scopeSave.addEventListener('click', saveScopeSelection);
    elements.scopeModal.addEventListener('click', event => {
        if (event.target === elements.scopeModal) closeScopeModal();
    });
    elements.uploadButton.addEventListener('click', () => startSync('upload'));
    elements.downloadButton.addEventListener('click', () => startSync('download'));
    elements.mode.value = loadStoredSyncMode();
    elements.mode.addEventListener('change', () => {
        saveSyncMode(elements.mode.value);
        renderModeHelp();
    });
    renderModeHelp();
    await refreshStatus();

    const context = getContext();
    context.eventSource?.on?.(context.eventTypes?.APP_READY, () => {
        refreshStatus().catch(() => {});
    });
}
