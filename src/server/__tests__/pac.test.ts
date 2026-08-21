/**
 * PAC support. The corporate Win11 machines that could not chat had a PAC
 * script configured via AutoConfigURL while ProxyEnable was 0 — Windows honours
 * the script anyway, so every other app was proxied and this one was not.
 */
import { describe, expect, test } from 'bun:test'
import {
  buildPacHelpers,
  evaluatePacScript,
  firstLocalIPv4,
  parsePacDirective,
  resolveProxyViaPac,
  shExpToRegExp,
  applySystemPacProxy,
} from '../../utils/pac.js'

const NO_DNS = { resolved: {}, myIp: '10.1.2.3' }

describe('parsePacDirective', () => {
  test('turns a PROXY entry into a usable http proxy URL', () => {
    expect(parsePacDirective('PROXY proxy.corp.example:8080')).toBe(
      'http://proxy.corp.example:8080',
    )
  })

  test('DIRECT means no proxy, not "no answer"', () => {
    expect(parsePacDirective('DIRECT')).toBeNull()
  })

  test('takes the first usable entry from a fallback list', () => {
    expect(parsePacDirective('PROXY a.corp:8080; PROXY b.corp:8080; DIRECT')).toBe(
      'http://a.corp:8080',
    )
  })

  test('honours DIRECT when it comes first', () => {
    expect(parsePacDirective('DIRECT; PROXY a.corp:8080')).toBeNull()
  })

  test('skips SOCKS entries and falls through to an HTTP one', () => {
    // Bun's fetch proxy speaks HTTP CONNECT; a SOCKS port would fail in a far
    // more confusing way than using the next entry.
    expect(parsePacDirective('SOCKS5 s.corp:1080; PROXY a.corp:8080')).toBe(
      'http://a.corp:8080',
    )
  })

  test('returns null when only SOCKS is offered rather than mis-pointing', () => {
    expect(parsePacDirective('SOCKS s.corp:1080')).toBeNull()
  })

  test('supports HTTPS proxies and tolerates sloppy whitespace', () => {
    expect(parsePacDirective('  HTTPS   secure.corp:8443 ; DIRECT ')).toBe(
      'https://secure.corp:8443',
    )
  })
})

describe('shExpToRegExp', () => {
  test('translates PAC wildcards without treating dots as any-char', () => {
    expect(shExpToRegExp('*.corp.example').test('a.corp.example')).toBe(true)
    expect(shExpToRegExp('*.corp.example').test('a.corpXexample')).toBe(false)
    expect(shExpToRegExp('10.*').test('10.0.0.1')).toBe(true)
    expect(shExpToRegExp('10.*').test('110.0.0.1')).toBe(false)
  })
})

describe('buildPacHelpers', () => {
  const h = buildPacHelpers({ resolved: { 'api.example.com': '10.8.0.9' }, myIp: '10.1.2.3' }) as any

  test('isPlainHostName distinguishes intranet short names', () => {
    expect(h.isPlainHostName('intranet')).toBe(true)
    expect(h.isPlainHostName('api.example.com')).toBe(false)
  })

  test('dnsResolve answers for the pre-resolved host and passes IPs through', () => {
    expect(h.dnsResolve('api.example.com')).toBe('10.8.0.9')
    expect(h.dnsResolve('10.0.0.5')).toBe('10.0.0.5')
    expect(h.dnsResolve('unknown.example.com')).toBeNull()
  })

  test('isInNet masks correctly', () => {
    expect(h.isInNet('api.example.com', '10.8.0.0', '255.255.0.0')).toBe(true)
    expect(h.isInNet('api.example.com', '10.9.0.0', '255.255.0.0')).toBe(false)
  })

  test('localHostOrDomainIs matches the bare host against its FQDN', () => {
    expect(h.localHostOrDomainIs('www', 'www.corp.example')).toBe(true)
    expect(h.localHostOrDomainIs('www.corp.example', 'www.corp.example')).toBe(true)
    expect(h.localHostOrDomainIs('other', 'www.corp.example')).toBe(false)
  })
})

describe('evaluatePacScript', () => {
  const CORPORATE_PAC = `
    function FindProxyForURL(url, host) {
      if (isPlainHostName(host)) return "DIRECT";
      if (shExpMatch(host, "*.corp.example")) return "DIRECT";
      return "PROXY gateway.corp.example:8080; DIRECT";
    }
  `

  test('routes an external host through the gateway', () => {
    const directive = evaluatePacScript(
      CORPORATE_PAC,
      'https://api.minimaxi.com/v1/messages',
      'api.minimaxi.com',
      NO_DNS,
    )
    expect(directive).toBe('PROXY gateway.corp.example:8080; DIRECT')
    expect(parsePacDirective(directive)).toBe('http://gateway.corp.example:8080')
  })

  test('keeps intranet hosts direct', () => {
    expect(
      evaluatePacScript(CORPORATE_PAC, 'http://wiki.corp.example/', 'wiki.corp.example', NO_DNS),
    ).toBe('DIRECT')
  })

  test('the sandbox exposes no host capabilities to the remote script', () => {
    // The PAC is remote code, even though the OS is what points us at it.
    const probe = `
      function FindProxyForURL(url, host) {
        return [
          typeof process,
          typeof require,
          typeof fetch,
          typeof globalThis.Bun,
addr      ].join(",");
      }
    `.replace('addr', '')
    const out = evaluatePacScript(probe, 'https://x.example/', 'x.example', NO_DNS)
    expect(out).toBe('undefined,undefined,undefined,undefined')
  })

  test('a runaway script is killed rather than hanging startup', () => {
    const evil = 'function FindProxyForURL(u,h){ while(true){} }'
    expect(() => evaluatePacScript(evil, 'https://x.example/', 'x.example', NO_DNS)).toThrow()
  })

  test('a script returning a non-string is rejected, not coerced', () => {
    const bad = 'function FindProxyForURL(u,h){ return 42 }'
    expect(() => evaluatePacScript(bad, 'https://x.example/', 'x.example', NO_DNS)).toThrow(
      /expected a string/,
    )
  })

  test('the host is passed as data, so it cannot inject script text', () => {
    const echo = 'function FindProxyForURL(u,h){ return "PROXY " + h + ":8080" }'
    const nasty = '"; while(true){} //'
    expect(evaluatePacScript(echo, 'https://x/', nasty, NO_DNS)).toBe(`PROXY ${nasty}:8080`)
  })
})

describe('resolveProxyViaPac', () => {
  test('fetches, evaluates and returns both the proxy and the raw directive', async () => {
    const script = 'function FindProxyForURL(u,h){ return "PROXY p.corp:3128; DIRECT" }'
    const res = await resolveProxyViaPac({
      pacUrl: 'http://wpad.corp.example/proxy.pac',
      targetUrl: 'https://api.minimaxi.com/v1/messages',
      fetchImpl: (async () => new Response(script, { status: 200 })) as unknown as typeof fetch,
      lookup: async () => null,
    })
    expect(res.proxyUrl).toBe('http://p.corp:3128')
    expect(res.directive).toBe('PROXY p.corp:3128; DIRECT')
  })

  test('a PAC URL that 404s fails loudly instead of silently going direct', async () => {
    await expect(
      resolveProxyViaPac({
        pacUrl: 'http://wpad.corp.example/proxy.pac',
        targetUrl: 'https://api.minimaxi.com/',
        fetchImpl: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
        lookup: async () => null,
      }),
    ).rejects.toThrow(/HTTP 404/)
  })

  test('an oversized response is refused rather than evaluated', async () => {
    const huge = 'x'.repeat(1024 * 1024 + 1)
    await expect(
      resolveProxyViaPac({
        pacUrl: 'http://wpad.corp.example/proxy.pac',
        targetUrl: 'https://api.minimaxi.com/',
        fetchImpl: (async () => new Response(huge, { status: 200 })) as unknown as typeof fetch,
        lookup: async () => null,
      }),
    ).rejects.toThrow(/over the/)
  })
})

describe('firstLocalIPv4', () => {
  test('prefers a non-internal IPv4 and ignores loopback', () => {
    expect(
      firstLocalIPv4({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
        eth0: [{ address: '10.4.5.6', family: 'IPv4', internal: false } as never],
      }),
    ).toBe('10.4.5.6')
  })

  test('falls back to loopback when there is no external interface', () => {
    expect(firstLocalIPv4({})).toBe('127.0.0.1')
  })
})

describe('applySystemPacProxy', () => {
  const PAC = 'function FindProxyForURL(u,h){ return "PROXY gw.corp:8080; DIRECT" }'
  const withPac = () => {
    globalThis.fetch = (async () => new Response(PAC, { status: 200 })) as never
  }
  const realFetch = globalThis.fetch

  test('does nothing when the machine has no PAC configured', async () => {
    const env: Record<string, string | undefined> = {}
    expect(await applySystemPacProxy(env)).toBeNull()
    expect(env.HTTPS_PROXY).toBeUndefined()
  })

  test('sets the proxy the script chose for the active provider', async () => {
    withPac()
    const env: Record<string, string | undefined> = {
      SUPERAI_PAC_URL: 'http://wpad.corp/proxy.pac',
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com',
    }
    const res = await applySystemPacProxy(env)
    expect(res?.proxyUrl).toBe('http://gw.corp:8080')
    expect(env.HTTPS_PROXY).toBe('http://gw.corp:8080')
    expect(env.HTTP_PROXY).toBe('http://gw.corp:8080')
    expect(env.SUPERAI_PROXY_SOURCE).toBe('pac')
    globalThis.fetch = realFetch
  })

  test('always keeps loopback out of the proxy, or the chat hangs forever', async () => {
    withPac()
    const env: Record<string, string | undefined> = {
      SUPERAI_PAC_URL: 'http://wpad.corp/proxy.pac',
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com',
    }
    await applySystemPacProxy(env)
    for (const entry of ['localhost', '127.0.0.1', '::1']) {
      expect(env.NO_PROXY).toContain(entry)
    }
    globalThis.fetch = realFetch
  })

  test('never overrides a proxy the user explicitly configured', async () => {
    withPac()
    const env: Record<string, string | undefined> = {
      SUPERAI_PAC_URL: 'http://wpad.corp/proxy.pac',
      HTTPS_PROXY: 'http://chosen.by.user:3128',
    }
    expect(await applySystemPacProxy(env)).toBeNull()
    expect(env.HTTPS_PROXY).toBe('http://chosen.by.user:3128')
    globalThis.fetch = realFetch
  })

  test('a DIRECT verdict is recorded as an answer, not a failure', async () => {
    globalThis.fetch = (async () =>
      new Response('function FindProxyForURL(u,h){ return "DIRECT" }', { status: 200 })) as never
    const env: Record<string, string | undefined> = {
      SUPERAI_PAC_URL: 'http://wpad.corp/proxy.pac',
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com',
    }
    await applySystemPacProxy(env)
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.SUPERAI_PROXY_SOURCE).toBe('pac-direct')
    globalThis.fetch = realFetch
  })

  test('an unreachable PAC leaves the environment untouched instead of throwing', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as never
    const env: Record<string, string | undefined> = {
      SUPERAI_PAC_URL: 'http://wpad.corp/proxy.pac',
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com',
    }
    expect(await applySystemPacProxy(env)).toBeNull()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.SUPERAI_PROXY_SOURCE).toBe('pac-failed')
    globalThis.fetch = realFetch
  })
})
