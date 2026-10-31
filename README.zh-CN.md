<p align="center">
  <img src=".github/assets/logo.svg" alt="Dinobot 标志" width="160">
</p>

# Dinobot

**Dinobot 的智能体守护进程与终端界面。**

在终端中与智能体协作，接入团队聊天，并按需添加工具。Dinobot 使用 TypeScript 和 Bun 构建：守护进程运行智能体，终端用户界面（TUI）在本机连接守护进程。

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

源码可查看 · [PolyForm Noncommercial 1.0.0](LICENSE) · 并非 OSI 认可的开源软件

## 演示

https://github.com/user-attachments/assets/6b7d112e-d469-4512-b97b-96999dcf8936

## 选择界面

- **Dinobot — 本仓库：** 智能体守护进程与 TUI。要运行核心服务或在终端中工作，请从这里开始。
- **Dinobot Desktop：** 基于 Electron/React 的桌面客户端，需要兼容的 Dinobot 守护进程。
  https://github.com/dinobot-labs/dinobot-desktop

## 可以做什么

| 功能 | 使用方式 |
| --- | --- |
| 在终端中工作 | 打开 TUI，通过 `/login` 登录模型提供商，再用 `/model` 选择模型。 |
| 接入聊天渠道 | 在配置文件中设置 Slack、Discord、Telegram 或本地 HTTP 渠道。消息适配器需要各自的凭据和访问设置。 |
| 添加工具 | 配置 MCP 服务器、浏览器与桌面自动化等插件。部分功能需要外部程序或服务账号。 |

配置示例见 [dinobot.example.yaml](dinobot.example.yaml)。启用插件并不会自动提供凭据或安装依赖程序。

## 安装与运行

需要 **Bun 1.4.2 或更高版本**和你自己的模型提供商凭据。从 Cloudflare 安装正式 CLI/TUI 软件包：

```bash
bun add -g https://releases.dinobot.workers.dev/core/dinobot.tgz
dinobot
```

之后运行 `dinobot update` 更新；使用 `dinobot update --no-restart` 可保持守护进程运行。旧 npm 发行版用户需要执行一次上述 URL 安装以切换更新来源。发布 Dinobot 不再需要 npm 账号，但第三方依赖仍从 npm 下载。Desktop 单独安装。

若要从源码运行，还需要 Git：

```bash
git clone https://github.com/dinobot-labs/dinobot.git
cd dinobot
bun install --frozen-lockfile
bun src/main.ts --help
bun src/main.ts tui
```

在 TUI 中使用 `/login` 登录模型提供商，再通过 `/model` 选择模型。如果没有正在运行的守护进程，TUI 会在后台启动一个；关闭 TUI 不会停止守护进程。

如需自定义配置，请参考 [dinobot.example.yaml](dinobot.example.yaml)，将设置保存为 `dinobot.yaml`，然后运行：

```bash
bun src/main.ts tui --config dinobot.yaml
```

不要把凭据写入配置文件。若要在前台运行守护进程而非 TUI，请使用 `bun src/main.ts serve --config dinobot.yaml`。

**本地运行不等于隔离运行。** HTTP API 没有身份验证，不构成多用户安全边界。请仅在可信的本机和账号下通过回环接口使用，不要将其暴露到互联网、不可信网络或公共代理。模型提供商及已启用的集成功能可能向外部服务发送数据。连接工具或聊天渠道前，请阅读 [SECURITY.md](SECURITY.md)。

本仓库不提供模型凭据或外部服务。遥测、问题报告及 OAuth 后端的运营不在此源码快照范围内；源码可查看不代表能够访问这些后端。

## 开发与贡献

```bash
bun run typecheck
bun test
bun run build
bun script/public-artifact-guard.ts
```

`bun run build` 会准备当前主机的可执行文件和原生扩展。`bun run release` 会构建并审查本地 npm 归档，但不会发布。仅构建源码并不会生成可安装的发行版。各平台的测试要求见开发指南；不要使用生产数据或真实凭据进行测试。

- [开发指南](docs/wiki/Development.md) — 检查命令与环境要求。
- [贡献指南](CONTRIBUTING.md) — issue、PR 与贡献者权利。
- [项目 Wiki](docs/wiki) — 开发与发布说明。
- [源码快照](PUBLIC_SNAPSHOT.md) — 公开范围与发行说明。

本仓库包含经过筛选的源码快照，而非完整的原始开发历史。

## 许可证

[PolyForm Noncommercial 1.0.0](LICENSE) 允许的非商业用途可免费使用。本项目**源码可查看，但并非 OSI 认可的开源软件**。商业使用需要相关权利人另行书面许可。许可证事宜请联系 dev0jsh@gmail.com。

第三方代码保留其原有许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
