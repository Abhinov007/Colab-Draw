/** @type {import('next').NextConfig} */
const backendHttpUrl = (
  process.env.HTTP_BACKEND_URL ??
  process.env.NEXT_PUBLIC_HTTP_URL ??
  "http://localhost:3001"
).replace(/\/+$/, "");

const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendHttpUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
