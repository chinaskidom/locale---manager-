import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

export default defineConfig(({ command, isPreview }) => {
  // These tooling endpoints bypass Worker authentication.
  process.env.X_LOCAL_EXPLORER = 'false'
  process.env.X_LOCAL_OBSERVABILITY = 'false'

  const interactive = command === 'serve' && !isPreview && !process.env.VITEST
  let origin: URL | undefined
  let tunnelName: string | undefined
  if (interactive) {
    try {
      const devVars = parseEnv(readFileSync(new URL('.dev.vars', import.meta.url), 'utf8'))
      origin = new URL(devVars.APP_ORIGIN ?? '')
      tunnelName = devVars.CLOUDFLARE_TUNNEL_NAME
      if (origin.protocol !== 'https:' || origin.origin !== devVars.APP_ORIGIN || !tunnelName?.trim()) {
        throw new Error()
      }
    } catch {
      throw new Error('Development requires an HTTPS APP_ORIGIN and CLOUDFLARE_TUNNEL_NAME in .dev.vars')
    }
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      // Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the shell for tunnel tooling.
      ...(process.env.VITEST ? [] : cloudflare({
        tunnel: interactive ? { name: tunnelName, autoStart: true } : false,
      })),
    ],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      cors: false,
      fs: {
        deny: [
          // Retain Vite's defaults when extending its deny list.
          '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
          '.dev.vars', '.dev.vars.*', '**/.wrangler/**',
        ],
      },
      allowedHosts: origin ? [origin.hostname] : [],
      ws: origin ? {
        protocol: 'wss',
        host: origin.hostname,
        clientPort: Number(origin.port || 443),
      } : undefined,
    },
  }
})
