### ESM import analyzer

A slimmed down version of [@vercel/nft](https://github.com/vercel/nft), removing support for:

- CommonJS / `require()`
- `__dirname`, `__filename` support
- global `process` variable
- Node builtins like `os`, `path` etc (and `node:`-prefixed equivalents)
- `.node` native imports
- legacy `main` and `module` package.json fields. Only `exports` supported.
- - other legacy dependency handling

It follows symlinks, but does not resolve them to real paths. The returned file list reflects how the runtime sees them.
