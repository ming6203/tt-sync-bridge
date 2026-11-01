# TT-Sync Bridge 安装与使用说明

本文说明三个角色分别是什么，以及每条命令里的路径应该填什么。

---

## 1. 架构和三个角色

```text
TT-Sync 服务端
  ↑ HTTPS + SPKI pin + Ed25519 签名会话
SillyTavern 服务端（安装 server 插件）
  ↑ 浏览器访问 SillyTavern
浏览器（安装前端扩展）
```

必须区分：

| 角色 | 作用 | 需要安装什么 |
|---|---|---|
| TT-Sync 服务端 | 保存共享工作区、接受配对和文件计划 | TT-Sync 本体 |
| SillyTavern 服务端 | 真正连接 TT-Sync、读写文件 | `server/` 服务器插件 |
| 浏览器 | 显示配置面板、触发上传/下载 | 前端扩展 |

**前端扩展不能单独完成同步。** 每个独立的 SillyTavern 服务端都需要安装一次服务器插件；同一台 SillyTavern 的所有浏览器设备共用这个服务器插件。

---

## 2. 路径先解释清楚

### `<SillyTavern>` 是什么

SillyTavern 实例根目录，里面应该能看到：

```text
package.json
config.yaml
server.js
public/
data/
plugins/
```

常见例子：

| 环境 | 实际路径示例 |
|---|---|
| Linux 普通部署 | `/opt/sillytavern` |
| Linux 用户目录部署 | `/home/用户名/SillyTavern` |
| Termux | `/data/data/com.termux/files/home/SillyTavern` |

安装后服务器插件位置必须是：

```text
<SillyTavern>/plugins/tt-sync-bridge/index.js
```

前端扩展位置必须是：

```text
<SillyTavern>/public/scripts/extensions/third-party/tt-sync-bridge/manifest.json
```

### `<TT_SYNC_STATE_DIR>` 是什么

TT-Sync 的状态目录，不是 SillyTavern 数据目录。

里面通常有：

```text
identity.json
peers.json
tls/
```

当前服务器的例子是：

```text
/root/tt-sync/state
```

### `<TT_SYNC_CONFIG>` 是什么

TT-Sync 的配置文件路径，通常叫 `config.toml`。

当前服务器的例子是：

```text
/root/tt-sync/config.toml
```

### 路径占位符

命令中的：

```text
/path/to/SillyTavern
```

只是示例，必须换成实际存在的 `<SillyTavern>` 目录，不能原样复制。

---

## 3. 安装服务器插件

### 方式 A：一条命令

在运行 SillyTavern 的服务器上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/ming6203/tt-sync-bridge/main/bootstrap.sh \
  | bash -s -- /实际/SillyTavern/路径
```

命令参数解释：

- `bootstrap.sh`：下载仓库并调用安装脚本
- `bash -s --`：从标准输入执行脚本，并把后面的参数传给脚本
- `/实际/SillyTavern/路径`：传给脚本的 `$1`，也就是 SillyTavern 根目录

Termux 例子：

```bash
curl -fsSL https://raw.githubusercontent.com/ming6203/tt-sync-bridge/main/bootstrap.sh \
  | bash -s -- /data/data/com.termux/files/home/SillyTavern
```

如果报：

```text
realpath: /path/to/SillyTavern: No such file or directory
```

说明忘了替换示例路径。

### 方式 B：克隆后安装

```bash
git clone https://github.com/ming6203/tt-sync-bridge.git
cd tt-sync-bridge
./install.sh /实际/SillyTavern/路径
```

`install.sh` 的参数就是 SillyTavern 根目录。

安装脚本会复制：

```text
server/    → <SillyTavern>/plugins/tt-sync-bridge/
根目录扩展 → <SillyTavern>/public/scripts/extensions/third-party/tt-sync-bridge/
```

---

## 4. 启用服务器插件

编辑：

```text
<SillyTavern>/config.yaml
```

至少确认：

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false
```

如果 `enableServerPlugins` 不存在，可以手动添加在顶层。

### Linux 重启

如果 ST 用 systemd 管理：

```bash
sudo systemctl restart sillytavern
```

服务名可能不是 `sillytavern`，请用实际服务名。

### Termux 重启

Termux 一般没有 systemd：

1. 在运行 ST 的终端按 `Ctrl + C`
2. 重新启动：
   ```bash
   cd /data/data/com.termux/files/home/SillyTavern
   ./start.sh
   ```
   或者：
   ```bash
   node server.js
   ```

启动日志中应出现：

```text
Initializing plugin from .../plugins/tt-sync-bridge/index.js
1 server plugin(s) are currently loaded.
```

验证服务器插件接口：

```text
https://你的ST地址/api/plugins/tt-sync-bridge/status
```

返回 JSON 才正常。若返回 404，说明服务器插件未安装或未启用。

---

## 5. 安装前端扩展

方式 A：在 SillyTavern 网页操作：

```text
扩展 → 安装扩展
URL: https://github.com/ming6203/tt-sync-bridge
Branch: main
```

方式 B：安装脚本已经自动复制好前端扩展，只需要刷新网页。

更新后建议使用 `Ctrl + F5` 强制刷新。

---

## 6. 更新时保留配对配置

安装和更新脚本会保留：

```text
<SillyTavern>/plugins/tt-sync-bridge/data/
```

其中：

```text
data/config.json
```

保存 TT-Sync 设备身份、SPKI pin 和配对状态。

因此使用脚本更新代码时，不需要重新配对。  
如果你手动删除整个 `plugins/tt-sync-bridge` 目录，配对配置才会丢失，需要重新生成配对链接。

## 7. 配对

配对必须由 TT-Sync 管理员在 **TT-Sync 服务端**生成，不是在 SillyTavern 上生成。

命令：

```bash
tt-sync \
  --state-dir /实际/TT-Sync状态目录 \
  --config-file /实际/TT-Sync配置文件 \
  pair open --rw --mirror --expires 10m
```

参数解释：

| 参数 | 含义 |
|---|---|
| `--state-dir` | TT-Sync 状态目录，包含 identity.json / peers.json / tls |
| `--config-file` | TT-Sync 的 config.toml |
| `pair open` | 生成一次性设备配对链接 |
| `--rw` | 允许读取和写入 |
| `--mirror` | 允许镜像模式删除 |
| `--expires 10m` | 链接 10 分钟后过期 |

输出中的：

```text
tauritavern://tt-sync/pair?v=2&url=...&token=...&exp=...&spki=...
```

复制到 SillyTavern 的：

```text
扩展 → 扩展程序选项 → TT-Sync 中转同步 → TT-Sync 配置链接
```

然后点击“保存并连接”。

注意：

- 配对链接是**一次性**的
- 每个独立的 SillyTavern 实例都要生成自己的链接
- 不要多个设备复用同一个链接
- 链接过期后重新生成

---

## 8. 选择同步内容

插件面板中点击：

```text
选择同步内容...
```

会显示可勾选的内容组，例如：

- 聊天记录
- 群组与群聊
- 角色卡
- 世界书
- 模型与生成预设
- 提示词与推理预设
- 快速回复
- 主题与界面
- 媒体与用户文件
- Vectors
- 用户头像与 Persona
- 扩展本体与扩展数据
- 酒馆助手脚本与变量
- 正则脚本与正则预设
- 用户设置 power_user
- API、密钥与代理相关设置

未勾选的内容不会生成上传计划，也不会下载到本地。

`API、密钥与代理相关设置`默认不勾选。勾选后会同步：

- `secrets.json`
- `extension_settings.apiKey`
- `extension_settings.apiUrl`
- `proxies`
- `selected_proxy`
- `oai_settings.reverse_proxy`
- `oai_settings.proxy_password`

这些是敏感数据，建议确认自己的使用环境后再启用。

扩展目录使用独立增量同步，不会因镜像模式删除目标端扩展目录。

## 9. 上传和下载

| 操作 | 含义 |
|---|---|
| 上传 ST → TT-Sync | 把当前 SillyTavern 的通用数据同步到 TT-Sync 工作区 |
| 下载 TT-Sync → ST | 从 TT-Sync 拉取通用数据和状态到当前 SillyTavern |

### 增量模式（默认）

- 比较文件大小和修改时间
- 传输新增或变化的文件
- 不删除目标端多余文件
- 脚本和正则按 ID 合并
- 保留目标端独有脚本/正则

### 镜像模式

- 源端是权威副本
- 会删除目标端在所选数据集里多余的文件
- 执行前会二次确认
- 上传镜像可能删除 TT-Sync 中 ST 没有的通用文件
- 下载镜像可能删除 ST 中 TT-Sync 没有的通用文件

共享同一个 TT-Sync 工作区时，请谨慎使用镜像上传。

扩展目录使用独立增量同步：会新增和更新扩展文件，但镜像模式不会删除目标端的扩展目录。TT-Sync Bridge 自身不会被同步。

扩展相关的 `extension_settings` 也会同步，但 `apiKey` 和 `apiUrl` 不参与同步。

---

## 10. 下载后必须刷新页面

SillyTavern 会在页面加载时把以下内容读入浏览器内存：

- 角色卡
- 正则
- 酒馆助手脚本
- 预设
- 用户设置
- persona

服务器端文件同步完成后不会自动重新加载。下载同步发生变化后，插件会弹刷新确认框。点击确认即可重新加载。

---

## 11. 数据范围

同步的通用文件：

- 聊天、群聊、群组
- 角色卡
- 世界书
- 预设
- instruct / context / sysprompt / reasoning
- 快速回复
- 主题、movingUI
- 背景、assets、缩略图
- 用户图片、文件、工作流
- vectors
- 用户头像
- 全局第三方扩展本体和扩展数据
- 用户扩展目录及其数据
- 扩展相关的 `extension_settings` 配置
- 可选：API、密钥和代理设置（默认关闭）

选择性状态同步：

- 当前预设状态
- `power_user` 用户设置
- persona 描述和 Persona Management 数据
- 酒馆助手全局脚本和全局变量
- 全局正则和正则预设

默认不处理：

- `secrets.json`
- TT 专属的 `_tauritavern/**`
- agent.* 数据

---

## 12. 私钥

TT-Sync 设备私钥保存在：

```text
<SillyTavern>/plugins/tt-sync-bridge/data/config.json
```

权限应为 `600`，不要提交到 Git，也不要发给别人。

清除本地配对只会删除本地配置，不会撤销 TT-Sync 服务端的设备授权。

---

## 13. 常见问题

### 404 / 连接不上

1. 检查服务器插件是否存在：
   ```bash
   ls <SillyTavern>/plugins/tt-sync-bridge/
   ```
2. 检查 `config.yaml` 是否启用 `enableServerPlugins: true`
3. 重启 SillyTavern
4. 访问 `/api/plugins/tt-sync-bridge/status`
5. 注意：前端扩展不能替代服务器插件

### ssh 命令里的 `/path/to/SillyTavern` 路径不存在

那只是示例路径。使用实际目录，例如：

```text
/data/data/com.termux/files/home/SillyTavern
```

### 配对链接失效

配对链接一次性且有时效，重新执行：

```bash
tt-sync --state-dir <状态目录> --config-file <配置> pair open --rw --mirror --expires 10m
```

### TT-Sync 地址不可达

在 SillyTavern 服务器上测试：

```bash
curl -k https://TT_SYNC_HOST:11111/v2/status
```

如果这里失败，插件也无法连接。

### 同步后内容没变化

刷新 SillyTavern 页面。角色卡、正则、脚本和预设不会实时热更新。
