# webterm through a bundler

The normal path for an application: ESM, subpath imports and full types.

```sh
npm install
npm run dev
```

`webterm` here is a `file:` dependency on the repository root, so the example
tracks the working tree. In a real project it is a version from npm.

`@xterm/xterm` and `@xterm/addon-fit` are peer dependencies and are listed here
as ordinary dependencies, which is what a consumer does. Nothing else needs
installing: the graphemes, webgl, canvas, image and web-links addons are
dynamic imports driven by options, so a bundler only pulls in the ones the
options actually reach.

Three stylesheets, and only two of them belong to this package. xterm's own is
yours to import because you may already have it.
