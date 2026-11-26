# Engine release checks

Pushes and pull requests build the engine and Rust/WASM dashboard from locked dependencies. Pull requests to `prod` and manual runs check Ubuntu and macOS with Node.js 22.12.0 and Node.js 24. On Ubuntu, browser tests run in Microsoft's Ubuntu Playwright image with the selected Node version. When upgrading Playwright, update the image tag and digest in `.github/scripts/run-browser-check.sh` to match. The macOS jobs install Chromium, Firefox and WebKit on the runner.

A separate check installs the Ubuntu Node.js 22.12.0 job's package archive in an empty project on a fresh Ubuntu runner. It runs `flowstride install --with-deps` with an empty browser cache, then runs the packaged example in Chromium and checks that all seven steps passed.

After a merge to `prod`, the Windows Node.js 22.12.0 job checks whether a successful PR run tested the exact merged file tree. If both Ubuntu engine jobs and the fresh Ubuntu install passed for that tree, only the two macOS engine jobs and the two Windows security jobs run. If GitHub cannot confirm those results, the full suite runs.

High and critical findings in shipped engine/dashboard dependencies fail the checks. Full development audits are retained separately. Package inventory and clean archive execution checks verify the distributable. Each operating system and Node.js combination retains its archive and audit evidence.

CI for the open-source engine uses public source only. The private engine repository can additionally check the matching public Flowstride source for installation, authorization, browser selection and engine fallback. Private engine source and archives stay in the private repository and download channel. Checks requiring both repositories can also be run locally with explicit source paths.

Browser tests qualify their covered paths; Three.js fixtures are qualified on Chromium. The documented Chromium locale and Firefox/WebKit forced-offline HAR limitations remain separate known cases. Passing tests do not establish every framework, device or operating-system combination.

Publishing is a separate operation. These workflows do not publish npm packages, upload the private download archive or change the Cloud service's selected download.
