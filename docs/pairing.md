# 配对说明

TT-Sync 使用 Ed25519 设备身份、签名会话和 TLS SPKI 固定。

在 TT-Sync 服务端生成一次性链接：

```bash
tt-sync --state-dir <state-dir> \
  --config-file <config.toml> \
  pair open --rw --mirror --expires 10m
```

把输出中的 `pair_uri` 填入 SillyTavern 插件面板。

需要注意：

- 配对链接是一次性密钥，不要公开。
- `--rw` 允许上传，`--mirror` 允许镜像删除。
- SillyTavern 在 TT-Sync 中会显示为独立设备。
- 插件私钥保存在服务器插件目录的 `data/config.json`，权限应为 `600`。
