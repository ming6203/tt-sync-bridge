# 同步范围

## 文件数据集

- chats / group chats / groups
- character cards
- world info
- OpenAI / NovelAI / TextGen / Kobold presets
- instruct / context / sysprompt / reasoning
- quick replies
- themes / moving UI
- backgrounds / assets / thumbnails
- user images / files / workflows
- vectors
- user avatars
- third-party extension code and data
- user-scoped extensions and data
- extension settings (`extension_settings`)
- API keys and proxy settings (`secrets.json`, `extension_settings.apiKey/apiUrl`, `proxies`, `selected_proxy`), opt-in and disabled by default

## 选择性状态桥接

- 当前预设选择和预设参数
- `power_user` 用户设置
- 用户名、用户头像、persona 描述和 Persona Management 数据
- Tavern Helper / JS-Slash-Runner 全局脚本与全局变量
- 全局正则、正则预设和正则允许列表

不主动同步：

- `secrets.json`
- `_tauritavern/**`
- `agent.*`
