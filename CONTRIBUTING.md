# Contributing

Develop inspired-lint in [MatsErdkamp/contractors-effect](https://github.com/MatsErdkamp/contractors-effect), under `packages/inspired-lint`. Open issues and pull requests in that monorepo. The standalone `MatsErdkamp/inspired-lint` repository is a one-way copy. Direct commits there prevent the next sync from advancing. The sync refuses to overwrite them.

For a standalone checkout, use Node 24 or later and run:

```sh
npm install --ignore-scripts
npm run check
npm test
npm run build
```

The monorepo owns the lint configuration. Its package `lint` script requires the monorepo checkout.
