# Build `github_pusher.msi`

The source project is configured for electron-builder's native Windows `msi` target and uses the exact artifact name `github_pusher.msi`.

From a Windows build machine:

```bash
npm install
npm run build:windows-installer -- --x64
```

The generated file is placed at `dist/github_pusher.msi`. Copy that file into this folder to make the website automatically expose it as the Windows download.

A GitHub Actions workflow is also included at `.github/workflows/build-windows-msi.yml`. It builds on `windows-latest` and uploads the MSI as a workflow artifact.
