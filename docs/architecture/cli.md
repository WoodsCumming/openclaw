# CLI 架构文档

> 文件路径：`src/cli/` + `src/commands/`
> 本文档描述 OpenClaw CLI 程序的详细架构，包含关键代码实现与行号引用。

---

## 1. 模块定位

CLI 是 OpenClaw 的命令行界面，基于 Commander.js 构建，通过 `buildProgram()` 创建完整的命令树。CLI 使用依赖注入模式（`createDefaultDeps()`），避免全局状态，便于测试和扩展。

---

## 2. 目录结构

```
src/cli/
├── program.ts                  # CLI 程序入口（re-export buildProgram）
├── program/                    # 程序实现（42 个文件）
│   ├── index.ts                # buildProgram 实现
│   └── ...                     # 各命令组注册
├── deps.ts                     # 依赖注入（createDefaultDeps）
├── outbound-send-mapping.ts    # 出站发送依赖映射
├── config-cli.ts               # 配置管理 CLI
├── memory-cli.ts               # 记忆操作 CLI
├── devices-cli.ts              # 设备管理 CLI
├── models-cli.ts               # 模型管理 CLI
├── secrets-cli.ts              # 密钥管理 CLI
├── security-cli.ts             # 安全操作 CLI
├── completion-cli.ts           # Shell 补全
├── hooks-cli.ts                # 钩子管理
├── logs-cli.ts                 # 日志查看
├── channels-cli.ts             # 渠道管理
├── skills-cli.ts               # 技能管理
├── plugins-cli.ts              # 插件管理
├── exec-approvals-cli.ts       # 执行审批管理
├── browser-cli.ts              # 浏览器控制
├── browser-cli-inspect.ts      # 浏览器检查
├── browser-cli-manage.ts       # 浏览器管理
├── browser-cli-extension.ts    # 浏览器扩展
├── browser-cli-debug.ts        # 浏览器调试
├── browser-cli-state.ts        # 浏览器状态
├── qr-cli.ts                   # QR 码生成
├── acp-cli.ts                  # ACP 协议 CLI
├── pairing-cli.ts              # 设备配对
├── sandbox-cli.ts              # 沙箱操作
├── gateway-cli/                # Gateway 操作（12 个文件）
├── daemon-cli/                 # 守护进程操作（22 个文件）
├── nodes-cli/                  # 原生节点管理（19 个文件）
├── cron-cli/                   # 定时任务（8 个文件）
├── argv.ts                     # 参数解析
├── banner.ts                   # CLI 横幅
├── progress.ts                 # 进度显示（osc-progress + @clack/prompts）
├── parse-duration.ts           # 时长解析
└── parse-bytes.ts              # 字节解析

src/commands/                   # 各子命令实现
├── gateway/                    # gateway 命令
├── agent/                      # agent 命令
├── message/                    # message 命令
├── channels/                   # channels 命令
├── models/                     # models 命令
├── config/                     # config 命令
├── sessions/                   # sessions 命令
├── cron/                       # cron 命令
├── onboard/                    # onboard 命令（交互式向导）
├── doctor/                     # doctor 命令（诊断）
├── skills/                     # skills 命令
├── nodes/                      # nodes 命令
├── browser/                    # browser 命令
└── ...
```

---

## 3. 依赖注入（`src/cli/deps.ts`）

CLI 通过 `createDefaultDeps()` 延迟加载各渠道的发送函数，避免在 CLI 启动时加载所有渠道模块（减少启动时间）：

```typescript
// src/cli/deps.ts:1-50
import type { sendMessageWhatsApp } from "../channels/web/index.js";
import type { sendMessageDiscord } from "../discord/send.js";
import type { sendMessageIMessage } from "../imessage/send.js";
import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import type { sendMessageSignal } from "../signal/send.js";
import type { sendMessageSlack } from "../slack/send.js";
import type { sendMessageTelegram } from "../telegram/send.js";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";

export type CliDeps = {
  sendMessageWhatsApp: typeof sendMessageWhatsApp;
  sendMessageTelegram: typeof sendMessageTelegram;
  sendMessageDiscord: typeof sendMessageDiscord;
  sendMessageSlack: typeof sendMessageSlack;
  sendMessageSignal: typeof sendMessageSignal;
  sendMessageIMessage: typeof sendMessageIMessage;
};

// 延迟加载（dynamic import）避免启动时加载所有渠道模块
export function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp: async (...args) => {
      const { sendMessageWhatsApp } = await import("../channels/web/index.js");
      return await sendMessageWhatsApp(...args);
    },
    sendMessageTelegram: async (...args) => {
      const { sendMessageTelegram } = await import("../telegram/send.js");
      return await sendMessageTelegram(...args);
    },
    sendMessageDiscord: async (...args) => {
      const { sendMessageDiscord } = await import("../discord/send.js");
      return await sendMessageDiscord(...args);
    },
    sendMessageSlack: async (...args) => {
      const { sendMessageSlack } = await import("../slack/send.js");
      return await sendMessageSlack(...args);
    },
    sendMessageSignal: async (...args) => {
      const { sendMessageSignal } = await import("../signal/send.js");
      return await sendMessageSignal(...args);
    },
    sendMessageIMessage: async (...args) => {
      const { sendMessageIMessage } = await import("../imessage/send.js");
      return await sendMessageIMessage(...args);
    },
  };
}

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}
```

---

## 4. 主要命令

| 命令 | 说明 |
|------|------|
| `openclaw gateway run` | 启动 Gateway 服务器 |
| `openclaw agent` | 直接运行 agent（不经过 Gateway） |
| `openclaw message send` | 发送消息到渠道 |
| `openclaw channels status` | 查看渠道状态（`--probe` 主动探测） |
| `openclaw models list` | 列出可用模型 |
| `openclaw config get/set` | 配置读写 |
| `openclaw sessions list` | 列出会话 |
| `openclaw cron list/add/remove/run` | 定时任务管理 |
| `openclaw onboard` | 交互式配置向导 |
| `openclaw doctor` | 诊断工具（检查配置、连接、版本） |
| `openclaw skills install` | 安装技能 |
| `openclaw nodes list` | 原生节点管理 |
| `openclaw browser` | 浏览器控制 |
| `openclaw plugins list/install` | 插件管理 |

---

## 5. 进度显示（`src/cli/progress.ts`）

CLI 使用 `osc-progress`（OSC 进度条）和 `@clack/prompts` spinner，提供统一的进度展示：

```
// 使用方式（不要手动创建 spinner/进度条）
import { createSpinner } from "./progress.js";
const spinner = createSpinner("正在加载...");
spinner.start();
// ...
spinner.stop();
```

---

## 6. 状态输出规范

- `openclaw channels status --all`：只读/可粘贴的纯文本输出
- `openclaw channels status --deep`：主动探测（发起实际连接测试）
- 表格输出通过 `src/terminal/table.ts` 保持 ANSI 安全换行

---

## 7. Shell 补全（`src/cli/completion-cli.ts`）

支持 Bash / Zsh / Fish 的 tab 补全，通过 Commander.js 的补全机制生成。

---

## 8. 入口

```
src/index.ts
  └── buildProgram()
        └── Commander.js 命令树
              ├── gateway run → src/commands/gateway/run.ts
              ├── agent → src/commands/agent/index.ts
              ├── message send → src/commands/message/send.ts
              └── ...
```
