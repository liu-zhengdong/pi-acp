import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'acp-extension': 'src/pi-rpc/acp-extension.ts',
    'pi-extension': 'src/runtime/extension.ts',
    identity: 'src/runtime/identity.ts'
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  minify: false,
  banner: {
    js: '#!/usr/bin/env node'
  }
})
