import { defineCloudflareConfig } from "@opennextjs/cloudflare"

// No incremental cache: every page is static, and the data is the API's.
export default defineCloudflareConfig({})
