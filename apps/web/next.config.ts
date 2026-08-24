import type { NextConfig } from "next"

const config: NextConfig = {
  reactStrictMode: true,
  // The control plane is a long-lived local process, so the dashboard proxies
  // to it rather than trying to run probe orchestration inside a request.
  async rewrites() {
    const controlPlane = process.env.SANDMAN_CONTROL_PLANE_URL ?? "http://127.0.0.1:8000"
    return [{ source: "/cp/:path*", destination: `${controlPlane}/:path*` }]
  },
}

export default config
