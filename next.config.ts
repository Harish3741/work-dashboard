import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; it must stay external to the server bundle.
  serverExternalPackages: ["better-sqlite3"],

  webpack(config, { nextRuntime, webpack }) {
    // `serverExternalPackages` covers the node server bundle, but dev also
    // compiles instrumentation.ts for the edge runtime, where webpack traces
    // the dynamic import of sync -> db and fails on better-sqlite3's `fs` and
    // on the `node:` builtins. register() already returns early unless
    // NEXT_RUNTIME is "nodejs", so that subtree never runs on edge — drop it
    // from the edge bundle entirely.
    if (nextRuntime === "edge") {
      config.plugins.push(
        new webpack.IgnorePlugin({ resourceRegExp: /(^|\/)lib\/sync(\.js)?$/ }),
      );
    }

    // src/lib uses NodeNext-style ".js" specifiers so it can be compiled and
    // unit-tested with plain tsc, outside the Next toolchain. Teach webpack to
    // resolve those back to the TypeScript sources.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
