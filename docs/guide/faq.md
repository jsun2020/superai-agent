# 常见问题


## Q: `undefined is not an object (evaluating 'usage.input_tokens')`

**原因**：`ANTHROPIC_BASE_URL` 配置不正确，API 端点返回的不是 Anthropic 协议格式的 JSON，而是 HTML 页面或其他格式。

本项目使用 **Anthropic Messages API 协议**，`ANTHROPIC_BASE_URL` 必须指向一个兼容 Anthropic `/v1/messages` 接口的端点。Anthropic SDK 会自动在 base URL 后面拼接 `/v1/messages`，所以：

- MiniMax：`ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic` ✅
- OpenRouter：`ANTHROPIC_BASE_URL=https://openrouter.ai/api` ✅
- OpenRouter 错误写法：`ANTHROPIC_BASE_URL=https://openrouter.ai/anthropic` ❌（返回 HTML）

如果你的模型供应商只支持 OpenAI 协议，需要通过 LiteLLM 等代理做协议转换，详见 [第三方模型使用指南](./third-party-models.md)。

## Q: `Cannot find package 'bundle'`

```
error: Cannot find package 'bundle' from '.../superai-agent/src/entrypoints/cli.tsx'
```

**原因**：Bun 版本过低，不支持项目所需的 `bun:bundle` 等内置模块。

**解决**：升级 Bun 到最新版本：

```bash
bun upgrade
```

## Q: 终端里启动 `superai` 为什么不接着上次的对话？怎么恢复历史、怎么压缩上下文省 token？

会话都保存在 `~/.claude/projects/<按目录划分>/` 下，一个目录一份。直接运行 `superai`（或 `superai-agent-tui.exe`）**总是新开一个会话**——这是刻意的：同一个目录下常常并行着好几个话题。当前目录已经有历史会话时，启动画面会多一行提示：

```
Last session 2h ago: fix the provider setup · superai -c continues it · /resume picks another
```

| 想做什么 | 命令 |
|---|---|
| 接着这个目录里**最近一次**会话 | `superai -c`（`--continue`） |
| 从列表里挑一个历史会话 | `superai -r`（`--resume`），或在会话中输入 `/resume` |
| 接着历史会话但另起一个新的会话 ID | `superai -c --fork-session` |
| 给会话起名字，方便以后在 `/resume` 里找 | `superai -n <名字>`，或会话中 `/rename` |
| **压缩上下文省 token** | 会话中输入 `/compact`（可加一句话说明重点，如 `/compact 只保留接口设计结论`）；上下文快满时也会**自动**压缩 |
| 看当前上下文用了多少 | `/context` |

`superai -c` 恢复的是完整对话（连同之前压缩过的摘要），恢复后随时可以 `/compact`。

## Q: 公司网络里报 `Unable to connect to API: Self-signed certificate detected` / 服务商测试显示 `self signed certificate in certificate chain`？

这是企业代理在做 TLS 解密（用公司自己的 CA 重新签发每个网站的证书）。浏览器能打开是因为公司 CA 装在 Windows / macOS 的系统证书库里；而 Bun 运行时默认只认自带的 Mozilla 根证书列表，所以桌面端、终端 UI、IM 适配器发出的 HTTPS 请求都会被拒。「网络代理」页的「测试」只做 CONNECT 握手、不校验证书，所以它显示 200 并不矛盾。

从 v0.2.18 起默认**同时信任系统证书库**：

- 终端 UI / 会话里的 API 调用：自动把 Windows / macOS 证书库里的 CA 追加到信任列表（`SUPERAI_USE_SYSTEM_CA=0` 可关闭）。
- 桌面端：`SuperAIAgent.exe` 启动时把系统证书库导出到 `~/.claude/superai/system-ca.pem`，并以 `NODE_EXTRA_CA_CERTS` 传给两个 sidecar（API 服务 + IM 适配器）；如果你自己在环境变量或 `~/.claude/superai/settings.json` 的 `env` 里设置了 `NODE_EXTRA_CA_CERTS`，以你的为准。

仍然失败时：把公司根证书导出成 PEM，设置环境变量 `NODE_EXTRA_CA_CERTS=<pem 路径>` 后重启应用；或者让 IT 把 SuperAI 使用的 API 域名加入代理的 TLS 解密白名单。

## Q: 终端 UI 里怎么切换权限模式？为什么只有 plan mode / accept edits 两种？

在输入框处按 **Shift+Tab**（Windows 便携版为 **Alt+M**）循环切换：`默认（逐个确认）→ accept edits on → plan mode on → bypass permissions on → 默认`。

`bypass permissions on` 从 v0.2.19 起默认就在循环里（此前只有以 `--dangerously-skip-permissions` 启动时才会出现）。第一次切换进去会弹出与启动时相同的警告对话框：选「Yes, I accept」后写入 `~/.claude/settings.json` 的 `skipDangerousModePermissionPrompt`，以后不再询问；选「No, stay in the current mode」则回到原模式，并且本次会话不再把它放进循环。

不想让它出现在循环里：设置环境变量 `SUPERAI_BYPASS_IN_CYCLE=0`，或在 `~/.claude/settings.json` 里写 `"permissions": { "disableBypassPermissionsMode": "disable" }`（后者同时禁用 `--dangerously-skip-permissions`）。Unix 上以 root 运行且不在沙箱中时不会提供。

## Q: 怎么接入 OpenAI / DeepSeek / Ollama 等非 Anthropic 模型？

本项目只支持 Anthropic 协议。如果模型供应商不直接支持 Anthropic 协议，需要用 [LiteLLM](https://github.com/BerriAI/litellm) 等代理做协议转换（OpenAI → Anthropic）。

详细配置步骤请参考：[第三方模型使用指南](./third-party-models.md)
