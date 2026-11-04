## What and why

<!-- What does this change, and which problem does it solve? Link the issue where we agreed
     on it: "Fixes #123". -->

## What changes for the user

<!-- One or two sentences for the CHANGELOG, written for someone who uses Foldwing,
     not for someone who reads the code. "Nothing visible" is a valid answer. -->

## How it was tested

<!-- Windows or Linux version, the results of `npm run typecheck` and `npm test`, manual checks.
     Main-process changes: built with `npm run dist:win` and started from release\win-unpacked.
     UI changes: a before/after screenshot with sample data. -->

## Checklist

- [ ] New or changed behaviour is covered by tests
- [ ] `npm run typecheck` and `npm test` pass
- [ ] No real files, links, domains, tokens, device IDs, user names or local paths in code, tests or screenshots
- [ ] Platform-specific code goes through `src/main/platform.ts`
- [ ] File contents still never go to third-party services, and downloads stay bit-identical
- [ ] A new dependency is listed in `THIRD-PARTY-NOTICES.md` (`node scripts/third-party-notices.mjs`) and its license is compatible with MIT
- [ ] I agree that this contribution is licensed under the [MIT License](https://github.com/FynnXland/foldwing/blob/main/LICENSE), without additional terms or conditions
