import type { NextConfig } from "next"

// The repo root has its own lockfile (bridge, web); this app is its own.
const nextConfig: NextConfig = {
  turbopack: { root: import.meta.dirname },
}

export default nextConfig
