# Contributing

The Darwin CLI is maintained in
[`darwin-studios/darwin`](https://github.com/darwin-studios/darwin) and
synchronized here after its API contract and tests pass.

Please open feature requests and bug reports in this repository. Code changes
should be submitted to the source repository so they are not overwritten by
the next synchronization.

Before opening a pull request, run:

```bash
npm install
npm run check
npm test
npm pack --dry-run
```
