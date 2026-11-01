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

```text
server/      SillyTavern server plugin
extension/   SillyTavern UI extension
docs/        pairing / scope / security docs
```

## 安装

先备份 SillyTavern。假设 SillyTavern 根目录为 `/path/to/SillyTavern`：

```bash
INSTALL_DIR=/path/to/SillyTavern
cp -R server "$INSTALL_DIR/plugins/tt-sync-bridge"
cp -R extension "$INSTALL_DIR/public/scripts/extensions/third-party/tt-sync-bridge"
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

前端扩展也可以从本仓库的 `extension` 分支安装：

```text
https://github.com/ming6203/tt-sync-bridge
Branch: extension
```

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

## 重要限制

SillyTavern 的角色卡、正则、脚本和预设会在页面加载时进入浏览器内存。下载同步完成后必须刷新页面才能生效。插件会在下载发生变化后弹出刷新提示。

## 许可证

AGPL-3.0
