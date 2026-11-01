import { getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { getRequestHeaders } from '../../../../script.js';

const API_BASE = '/api/plugins/tt-sync-bridge';
let pollTimer = null;
let busy = false;

function ui() {
    return {
        status: document.querySelector('#tt_sync_connection_status'),
        serverInfo: document.querySelector('#tt_sync_server_info'),
        pairUri: document.querySelector('#tt_sync_pair_uri'),
        pairButton: document.querySelector('#tt_sync_pair_btn'),
        disconnectButton: document.querySelector('#tt_sync_disconnect_btn'),
        mode: document.querySelector('#tt_sync_mode'),
        modeHelp: document.querySelector('#tt_sync_mode_help'),
        uploadButton: document.querySelector('#tt_sync_upload_btn'),
        downloadButton: document.querySelector('#tt_sync_download_btn'),
        progress: document.querySelector('#tt_sync_progress'),
        progressText: document.querySelector('#tt_sync_progress_text'),
        log: document.querySelector('#tt_sync_log'),
    };
}

async function apiGet(pathname) {
    const response = await fetch(`${API_BASE}${pathname}`, {
        method: 'GET',
        headers: getRequestHeaders(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

async function apiPost(pathname, body) {
    const response = await fetch(`${API_BASE}${pathname}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
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
                    || summary.stateUpdated === true
                );
                if (downloadChanged) {
                    if (window.confirm('下载同步已完成。角色卡、正则、用户设定、脚本和预设等数据需要刷新页面才会生效。现在刷新？')) {
                        location.reload();
                    }
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
    const mode = ui().mode?.value || 'incremental';
    const label = direction === 'upload' ? '上传 ST → TT-Sync' : '下载 TT-Sync → ST';

    if (mode === 'mirror') {
        const message = direction === 'upload'
            ? '镜像上传会以 ST 的通用数据集为准，删除 TT-Sync 上通用数据集中 ST 不存在的文件。确定继续？'
            : '镜像下载会以 TT-Sync 的通用数据集为准，删除 ST 中通用数据集里 TT-Sync 不存在的文件。下载前会自动备份当前 ST 通用数据。确定继续？';
        if (!window.confirm(message)) return;
    }

    try {
        setBusy(true);
        const result = await apiPost('/sync', {
            direction,
            mode,
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
    elements.uploadButton.addEventListener('click', () => startSync('upload'));
    elements.downloadButton.addEventListener('click', () => startSync('download'));
    elements.mode.addEventListener('change', renderModeHelp);
    renderModeHelp();
    await refreshStatus();

    const context = getContext();
    context.eventSource?.on?.(context.eventTypes?.APP_READY, () => {
        refreshStatus().catch(() => {});
    });
}
