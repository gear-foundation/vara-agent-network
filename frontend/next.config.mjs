import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const webpack = require('next/dist/compiled/webpack/webpack-lib.js')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  transpilePackages: [
    '@gear-js/api',
    '@polkadot/api',
    '@polkadot/extension-dapp',
    '@polkadot/util',
    '@polkadot/util-crypto',
    'sails-js',
    'sails-js-parser',
  ],
  images: {
    unoptimized: true,
  },
  webpack: (config) => {
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
        resource.request = resource.request.replace(/^node:/, '')
      }),
    )

    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      'node:assert': require.resolve('assert'),
    }

    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      assert: require.resolve('assert'),
    }

    return config
  },
  turbopack: {
    root: __dirname,
  },
}

export default nextConfig
