/** @type {import('next').NextConfig} */
module.exports = {
  /// start
  swcMinify: false,
  experimental: {
    serverMinification: false
  },
  webpack: (config) => {
    config.optimization.minimize = false;
    return config;
  },
  compress: false,
  /// end

  poweredByHeader: false,
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true
  },

  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.shopify.com',
        pathname: '/s/files/**'
      }
    ]
  }
};
