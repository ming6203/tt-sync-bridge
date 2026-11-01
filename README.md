# TT-Sync Bridge for SillyTavern

将 SillyTavern 连接到现有 **TT-Sync v2** 工作区，并在 SillyTavern 扩展面板中执行上传与下载。

## 功能

- 使用 TT-Sync 设备配对、Ed25519 签名会话和 TLS SPKI 固定
- 支持增量同步与镜像同步
- 默认增量模式不会删除目标端多余文件
- 下载前自动备份当前 ST 数据
- 只同步约定的通用数据集
- 选择性同步预设状态、用户设置、persona、正则和 Tavern Helper 全局脚本
- TT-Sync 私钥仅保存在服务器端，不发送到浏览器

## 目录结构

仓库根目录本身就是 SillyTavern UI 扩展，包含 `manifest.json`、`index.js`、`settings.html` 和 `style.css`。

```text
.            SillyTavern UI extension (default branch)
server/      SillyTavern server plugin
docs/        pairing / scope / security docs
```

## 安装

> SillyTavern 的“安装扩展”只能安装前端扩展，不能安装服务器插件。服务端插件需要一次性在运行 SillyTavern 的服务器上安装。安装完成后，所有访问这台 SillyTavern 的浏览器设备都能使用。

### 一条命令安装（服务器 SSH）

```bash
curl -fsSL https://raw.githubusercontent.com/ming6203/tt-sync-bridge/main/bootstrap.sh | bash -s -- /path/to/SillyTavern
```

然后确认 `config.yaml`：

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false
```

重启 SillyTavern。

### 手动安装

先备份 SillyTavern。假设 SillyTavern 根目录为 `/path/to/SillyTavern`：

```bash
INSTALL_DIR=/path/to/SillyTavern
mkdir -p "$INSTALL_DIR/public/scripts/extensions/third-party/tt-sync-bridge"
cp manifest.json index.js settings.html style.css \
  "$INSTALL_DIR/public/scripts/extensions/third-party/tt-sync-bridge/"
cp -R server "$INSTALL_DIR/plugins/tt-sync-bridge"
chown -R "$(stat -c '%U:%G' "$INSTALL_DIR")" \
  "$INSTALL_DIR/plugins/tt-sync-bridge" \
  "$INSTALL_DIR/public/scripts/extensions/third-party/tt-sync-bridge"
```

在 SillyTavern 的 `config.yaml` 中启用服务器插件：

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false
```

然后重启 SillyTavern。

前端扩展可以直接从默认分支安装：

```text
https://github.com/ming6203/tt-sync-bridge
Branch: main（或留空使用默认分支）
```

旧的 `extension` 分支仍然保留用于兼容，但不再需要。

## 配对

在 TT-Sync 服务器生成一次性配对链接：

```bash
tt-sync --state-dir <TT_SYNC_STATE_DIR> \
  --config-file <TT_SYNC_CONFIG> \
  pair open --rw --mirror
```

在 SillyTavern 中打开：

```text
扩展 → 扩展程序选项 → TT-Sync 中转同步
```

把 `tauritavern://tt-sync/pair?...` 配对链接填入并保存。

## 同步模式

- **增量模式**：同步新增或变化的文件，不删除目标端多余文件。
- **镜像模式**：源端为权威副本，会删除目标端在所选数据集里多余的文件。

镜像模式执行前需要二次确认。共享同一个 TT-Sync 工作区时请谨慎使用。

## 404 / 无法连接排查

前端扩展只是界面，真正连接 TT-Sync 的是 SillyTavern 服务器插件。

每个运行 SillyTavern 的服务器都必须安装服务端插件：

```text
/path/to/SillyTavern/plugins/tt-sync-bridge/index.js
/path/to/SillyTavern/plugins/tt-sync-bridge/manifest.js
/path/to/SillyTavern/plugins/tt-sync-bridge/state-sync.js
/path/to/SillyTavern/plugins/tt-sync-bridge/ttsync-client.js
/path/to/SillyTavern/plugins/tt-sync-bridge/package.json
```

并确认：

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false
```

修改后必须重启 SillyTavern。然后在浏览器中确认这个接口返回 JSON：

```text
/api/plugins/tt-sync-bridge/status
```

如果该接口是 404，说明服务端插件没有加载成功。

TT-Sync 配对链接是一次性的，并且每个 SillyTavern 实例都要单独生成一个：

```bash
tt-sync --state-dir <state-dir> --config-file <config.toml> \
  pair open --rw --mirror --expires 10m
```

不要在多个设备之间复用同一个配对链接。

## 重要限制

SillyTavern 的角色卡、正则、脚本和预设会在页面加载时进入浏览器内存。下载同步完成后必须刷新页面才能生效。插件会在下载发生变化后弹出刷新提示。

## 许可证

AGPL-3.0
