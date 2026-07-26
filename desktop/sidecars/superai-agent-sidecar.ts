/**
 * SuperAI Agent 桌面端合并 sidecar 入口。
 *
 * 历史上 server / cli / IM adapters 是各自独立的进程。每个 bun-compile
 * 二进制都要带一份 ~55MB 的 bun runtime，光这一项就重复占了 100MB+。
 * 把所有运行模式合并到同一个二进制里，runtime 只保留一份；调用方通过
 * 第一个 positional 参数选择模式：
 *
 *   superai-agent-sidecar server       --app-root <path> --host 127.0.0.1 --port 12345
 *   superai-agent-sidecar cli          --app-root <path> [其它 CLI 参数...]
 *   superai-agent-sidecar adapters     --app-root <path> [--feishu] [--telegram] [--wechat]
 *   superai-agent-sidecar wechat-login                  # 一次性扫码登录
 *
 * 任何模式都必须先做 process.env / process.argv 设置，再 await 进入相应的
 * 子模块树。原因：src/server/index.ts、src/entrypoints/cli.tsx、以及
 * adapters/feishu/index.ts 等顶层都会立即读 process.argv / process.env，
 * 必须在它们求值前 splice 掉 --app-root、mode、--feishu/--telegram 这些
 * launcher-only 参数。
 */

import { registerVendorBinDir } from '../../src/utils/vendorBinDir'
import { parseLauncherArgs, resolveSidecarInvocation } from './launcherRouting'

// 便携包会把第三方工具二进制放在 exe 旁的 vendor/ 目录（如 officecli.exe，
// 由 scripts/build-portable.ps1 staging）。必须在任何模式模块加载/子进程
// spawn 之前把它加进 PATH。开发模式下没有 vendor 目录，此调用是 no-op。
registerVendorBinDir()

const rawArgs = process.argv.slice(2)
const invocation = resolveSidecarInvocation(rawArgs)
if (!invocation.mode) {
  // Friendly help text for users who double-click this binary directly.
  // superai-agent-sidecar.exe is an internal helper that SuperAIAgent.exe spawns as
  // a child process with a mode argument. Without that arg it has no work
  // to do — but a raw "missing mode" error makes it look like a crash.
  //
  // Use stdout (console.log), not stderr: Windows conhost renders stderr
  // text in red, which makes the friendly message look like a fatal error
  // even though it isn't.
  console.log('')
  console.log('superai-agent-sidecar.exe is an internal helper, not meant to run directly.')
  console.log('')
  console.log('  - Double-click SuperAIAgent.exe                : desktop window (recommended)')
  console.log('  - Run superai-agent-tui.exe                    : terminal UI version')
  console.log('  - Run superai-agent-sidecar.exe wechat-login   : only direct use - scan WeChat QR')
  console.log('')
  console.log(
    'Internal modes (used by SuperAIAgent.exe): server, cli, adapters, wechat-login.',
  )
  console.log('')
  // 5-second pause so a user who double-clicked can read the message before
  // the console window closes. No-op when run from an existing terminal.
  const sleep = Number(process.env.CLAUDE_SIDECAR_HELP_PAUSE_MS ?? 5000)
  if (sleep > 0) await new Promise((r) => setTimeout(r, sleep))
  process.exit(0)
}
const mode = invocation.mode
const restArgs = invocation.restArgs

if (mode === 'adapters') {
  await runAdapters(restArgs)
} else if (mode === 'wechat-login') {
  // 一次性扫码登录 —— 不需要 --app-root，沿用 adapters/wechat/login.ts 顶层逻辑。
  process.env.CALLER_DIR ||= process.cwd()
  await import('../../preload.ts')
  await import('../../adapters/wechat/login.ts')
} else {
  const { appRoot, args } = parseLauncherArgs(restArgs, invocation.defaultAppRoot)

  process.env.CLAUDE_APP_ROOT = appRoot
  process.env.CALLER_DIR ||= process.cwd()
  process.argv = [process.argv[0]!, process.argv[1]!, ...args]

  await import('../../preload.ts')

  if (mode === 'server') {
    const { startServer } = await import('../../src/server/index.ts')
    startServer()
  } else if (mode === 'cli') {
    await import('../../src/entrypoints/cli.tsx')
  } else {
    console.error(
      `superai-agent-sidecar: unknown mode "${mode}" (expected "server", "cli", "adapters", or "wechat-login")`,
    )
    process.exit(2)
  }
}

async function runAdapters(rawArgs: string[]): Promise<void> {
  // adapters 模式的参数解析独立于 server/cli —— 这里只接受 --feishu /
  // --telegram 选择启用哪个适配器，再加可选的 --app-root（透传给
  // adapters/common/config.ts 内的 process.env 读取）。
  let appRoot: string | null = process.env.CLAUDE_APP_ROOT ?? null
  let enableFeishu = false
  let enableTelegram = false
  let enableWechat = false

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (arg === '--app-root') {
      appRoot = rawArgs[i + 1] ?? null
      i += 1
      continue
    }
    if (arg === '--feishu') {
      enableFeishu = true
      continue
    }
    if (arg === '--telegram') {
      enableTelegram = true
      continue
    }
    if (arg === '--wechat') {
      enableWechat = true
      continue
    }
    console.warn(`superai-agent-sidecar adapters: ignoring unknown arg "${arg}"`)
  }

  if (!enableFeishu && !enableTelegram && !enableWechat) {
    console.error(
      'superai-agent-sidecar adapters: must enable at least one of --feishu / --telegram / --wechat',
    )
    process.exit(2)
  }

  if (appRoot) {
    process.env.CLAUDE_APP_ROOT = appRoot
  }
  process.env.CALLER_DIR ||= process.cwd()

  await import('../../preload.ts')

  // 在 import adapter 之前先用同一份 loadConfig() 检查凭据。adapter 的
  // top-level 代码里已经有 if (!cred) process.exit(1)，但那会把整个
  // 进程拖死 —— 包括另一个本来正常的 adapter。这里提前 gate 一下，
  // 缺凭据的 adapter 直接跳过、不 import。
  const { loadConfig } = await import('../../adapters/common/config.ts')
  const config = loadConfig()

  let started = 0

  if (enableFeishu) {
    if (!config.feishu.appId || !config.feishu.appSecret) {
      console.warn(
        '[superai-agent-sidecar] --feishu requested but FEISHU_APP_ID / FEISHU_APP_SECRET missing in env or ~/.claude/adapters.json — skipping',
      )
    } else {
      console.log('[superai-agent-sidecar] starting Feishu adapter')
      // 副作用 import：feishu/index.ts 顶层会自动 new WSClient + start()
      await import('../../adapters/feishu/index.ts')
      started += 1
    }
  }

  if (enableTelegram) {
    if (!config.telegram.botToken) {
      console.warn(
        '[superai-agent-sidecar] --telegram requested but TELEGRAM_BOT_TOKEN missing in env or ~/.claude/adapters.json — skipping',
      )
    } else {
      console.log('[superai-agent-sidecar] starting Telegram adapter')
      // 副作用 import：telegram/index.ts 顶层会自动 bot.start()
      await import('../../adapters/telegram/index.ts')
      started += 1
    }
  }

  if (enableWechat) {
    // wechat 没有 env-only 凭据 —— 凭据是 ~/.claude/wechat-accounts/<id>.json，
    // 由 `superai-agent-sidecar wechat-login` 一次性扫码生成。这里只检查是否存在
    // 任意账号；缺账号就 warn + skip，跟 feishu / telegram 缺凭据时同等处理。
    const { listAccounts } = await import('../../adapters/wechat/account-store.ts')
    const accounts = listAccounts()
    if (accounts.length === 0) {
      console.warn(
        '[superai-agent-sidecar] --wechat requested but no account found under ~/.claude/wechat-accounts/. Run `superai-agent-sidecar wechat-login` first — skipping',
      )
    } else {
      console.log('[superai-agent-sidecar] starting Wechat adapter')
      await import('../../adapters/wechat/index.ts')
      started += 1
    }
  }

  if (started === 0) {
    console.error(
      '[superai-agent-sidecar] no adapter could be started — check credentials in env or ~/.claude/adapters.json',
    )
    process.exit(1)
  }

  // 让进程保持存活：两个 adapter 都通过 long-lived WebSocket（Lark WSClient
  // / grammY long-polling）持有 event loop，自然不会退出。这里不需要额外
  // setInterval 兜底。两个 adapter 自己注册的 SIGINT handler 都会触发。
}
