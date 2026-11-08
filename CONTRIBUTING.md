# Branches

| Branch | What it is | How it moves |
|---|---|---|
| `main` | The released state | Only the repo owner, by PR from `build` |
| `build` | Integration branch and GitHub's default. All work lands here first | PRs from task branches, and commits from the main local checkout |
| `feat/*`, `fix/*`, `chore/*`, `docs/*` | One task, cut from `build` | Its author. A cloud session uses the branch it's given |

## Rules

- Nobody but the owner commits, pushes or merges to `main`.
- Task branches open a PR into `build`. Merge with a merge commit, then delete the branch.
- The main local checkout stays on `build` and commits there directly, because parallel local workers share that one checkout.
- Two writers never work on the same files at once.
- Never force-push `main` or `build`.
- Stage files by explicit path, not with `git add .`.

## Releasing

Run every test suite on `build`, tag it, then the owner opens a PR from `build` to `main` and merges it.

## Code quality

Install dependencies with `pnpm install`. Root tooling covers `worker/`, `shared/`, `scripts/`, `near/`,
and `evm/`; it excludes the web app, copied dependencies and generated output.
ESLint applies the JavaScript and TypeScript recommended rules to TypeScript in `worker/`, `shared/`,
and `scripts/`, with Prettier compatibility last.

- `pnpm lint`: lint TypeScript without modifying files.
- `pnpm format` / `pnpm format:check`: write/check Prettier-supported files in the scoped folders and root tooling.
- `pnpm fmt:rust` / `pnpm fmt:rust:check`: write/check Rust formatting across the NEAR workspace.
- `pnpm fmt:sol` / `pnpm fmt:sol:check`: write/check Solidity formatting in the EVM project.

Keep tooling/lint changes separate from formatter-only changes so both diffs remain reviewable.
