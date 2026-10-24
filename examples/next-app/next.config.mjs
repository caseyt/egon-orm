import { fileURLToPath } from "node:url";

/** The workspace root: the packages are linked from it, and the build traces files up to it. */
const root = fileURLToPath(new URL("../..", import.meta.url));

/** @type {import("next").NextConfig} */
export const nextConfig = {
  outputFileTracingRoot: root,
  turbopack: { root },
};

// Next.js reads the configuration from the default export.
export default nextConfig;
