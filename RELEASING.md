# Release checklist

Publishing is performed by the `Publish package` GitHub Actions workflow when a
`v<package-version>` tag is pushed. Before the first release, configure npm
trusted publishing for `@mp-complete/pi-wsl-notify` with this repository and
`.github/workflows/publish.yml`, then protect the repository's `npm` environment
with the required release approval policy. Do not put npm tokens in this repo.

1. Review compatibility and release notes. Initial support is Pi 1.0.0 on Node
   22.19+; a broad host peer range is required by Pi, not proof all versions work.
2. Run `npm ci --ignore-scripts --no-audit --no-fund` and `npm run check`.
   Require green CI and review the untested live-behavior notes in the README.
3. Inspect `npm pack --ignore-scripts --dry-run --json`. Only `package.json`,
   `extensions/wsl-notify.ts`, `README.md`, `LICENSE`, and `NOTICE` should ship.
   No credentials, sessions, private deployment configuration, dependency tree,
   development tests, or tarballs belong in the publication.
4. Confirm the intended GitHub and npm accounts and that the trusted-publisher
   configuration can publish under `@mp-complete`; GitHub ownership does not
   grant npm scope access.
5. Update the version and lockfile if needed; review and commit the release
   content. Once actually publishing, remove the README's unpublished-status
   note as part of that release. Keep a clean working tree.
6. Create and push a matching `v<package-version>` tag. The workflow verifies
   the tag against `package.json`, runs `npm run check`, and publishes with npm
   provenance after the `npm` environment approval.
7. Verify the registry version and tarball file list. Record `dist.integrity`
   from `npm view @mp-complete/pi-wsl-notify@0.1.0 dist --json`.
8. Update Nix consumers using the exact release version and integrity hash;
   remove the older notifier instead of loading both. Activation is separate.

Local pack verification can use an out-of-tree directory:

```sh
pack_dir=$(mktemp -d)
npm pack --ignore-scripts --pack-destination "$pack_dir"
```

The release has no install/prepare lifecycle scripts and bundles no Pi peers.
