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

需要 **[Bun 1.4.2 或更高版本](https://bun.sh/docs/installation)**和你自己的模型提供商凭据。以下脚本从 Cloudflare 安装 CLI/TUI，不使用 sudo，也不修改现有全局软件包。没有 Bun 时会显示安装说明并退出。Desktop 单独安装。

**macOS / Linux**

```sh
curl -fsS https://releases.dinobot.workers.dev/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://releases.dinobot.workers.dev/install.ps1 | iex
```

使用安装程序输出的 launcher 路径，或将其 bin 目录加入 PATH 后运行 `dinobot`。旧的全局命令可能在 PATH 中优先：此时请使用输出的绝对路径。现有全局安装不会被删除。

**自动更新：**管理型 launcher 每次启动时检查 Cloudflare，验证 SHA-512，并在独立版本目录中安装更新的稳定版后再切换选择。`dinobot update` 可立即检查而不启动界面。下载或安装失败时保留旧版本，不自动降级。第三方依赖由 Bun 从包注册表下载。

新的 CLI/TUI 进程使用已选版本。**更新程序不会重启正在运行的守护进程，即使它处于空闲状态。**正在执行的请求、排队任务和子代理继续使用旧文件。守护进程自然退出后，通过管理型 launcher 下次启动才使用新版本。仅关闭 TUI 不会停止守护进程。这不是后台定时更新或热替换；源码 checkout 和旧的全局安装不会自动获得此功能。

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
