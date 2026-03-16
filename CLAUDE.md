## 基本姿勢

- ユーザーの入力（Issue、コメント、指示）を鵜呑みにしない
- 要件の矛盾、技術的な誤り、既存コードとの不整合、考慮漏れなどに気づいた場合は、作業を進める前に指摘・確認する
- 「言われた通りにやる」より「正しいものを作る」を優先する

## Workflow: 仕様駆動開発

Issue で `@claude` に依頼される作業は、プラン生成と実装の2フェーズに分かれる。

### Phase 1: プラン生成

「プランを作って」等の依頼時:

- コードの変更は一切行わない（読み取り専用で分析のみ）
- Issue 本文・全コメントから要件を把握し、コードベースを探索する

#### 複雑さの判断

以下のいずれかに該当する場合は「複雑すぎる」と判断する:

- 要件が曖昧・矛盾しており、確認なしに実装方針を決定できない
- 実装ステップが 7 件を超える
- 複数の独立した機能を同時に実装する必要がある

**優先順位:** 要件が不明確な場合はまず質問（下記 A）を行う。要件は明確だが規模が大きい場合はフェーズ分割（下記 B）を提案する。

#### A. 要件が不明確な場合: 質問フォーマット

通常のプランではなく以下のフォーマットでコメント投稿する:
Questions Before Planning
要件を確認せずにプランを生成することが困難です。以下の点を教えてください:

[質問]

#### B. 実装規模が大きい場合: フェーズ分割提案フォーマット

通常のプランではなく以下のフォーマットでコメント投稿する:

Implementation Plan (Phase Split Proposal)
実装範囲が大きいため、以下の複数フェーズへの分割を提案します:

Phase A: [タイトル]
[ステップ一覧]
Phase B: [タイトル]
[ステップ一覧]
各フェーズを個別の Issue/PR として進めることを推奨します。

#### 通常のプラン: フォーマット

上記の複雑さ判断に該当しない場合は以下のフォーマットでコメント投稿する:

Implementation Plan
Summary
[1-2文]

Requirements Analysis
[要件→技術タスクのマッピング]
Codebase Analysis
関連する既存コード: [ファイルパス]
従うべきパターン: [既存パターン]
Implementation Steps
[タイトル] — 対象: path/to/file — [説明]
Testing Strategy
[テスト方針]
Risks and Open Questions
[リスク・未解決事項]

- 過去プランへのフィードバックがある場合は改訂版を投稿し、変更点を明記する

### Phase 2: 実装

「実装して」「PRを作って」等の依頼時:

- Issue コメント内の最新 "## Implementation Plan" に従う
- テスト・リンターがあれば実行する
- PR を作成し `Closes #Issue番号` で Issue を自動クローズする
- プランからの逸脱があれば PR 本文に理由を記載する

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, but it invokes Vite through `vp dev` and `vp build`.

## Vite+ Workflow

`vp` is a global binary that handles the full development lifecycle. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

### Start

- create - Create a new project from a template
- migrate - Migrate an existing project to Vite+
- config - Configure hooks and agent integration
- staged - Run linters on staged files
- install (`i`) - Install dependencies
- env - Manage Node.js versions

### Develop

- dev - Run the development server
- check - Run format, lint, and TypeScript type checks
- lint - Lint code
- fmt - Format code
- test - Run tests

### Execute

- run - Run monorepo tasks
- exec - Execute a command from local `node_modules/.bin`
- dlx - Execute a package binary without installing it as a dependency
- cache - Manage the task cache

### Build

- build - Build for production
- pack - Build libraries
- preview - Preview production build

### Manage Dependencies

Vite+ automatically detects and wraps the underlying package manager such as pnpm, npm, or Yarn through the `packageManager` field in `package.json` or package manager-specific lockfiles.

- add - Add packages to dependencies
- remove (`rm`, `un`, `uninstall`) - Remove packages from dependencies
- update (`up`) - Update packages to latest versions
- dedupe - Deduplicate dependencies
- outdated - Check for outdated packages
- list (`ls`) - List installed packages
- why (`explain`) - Show why a package is installed
- info (`view`, `show`) - View package information from the registry
- link (`ln`) / unlink - Manage local package links
- pm - Forward a command to the package manager

### Maintain

- upgrade - Update `vp` itself to the latest version

These commands map to their corresponding tools. For example, `vp dev --port 3000` runs Vite's dev server and works the same as Vite. `vp test` runs JavaScript tests through the bundled Vitest. The version of all tools can be checked using `vp --version`. This is useful when researching documentation, features, and bugs.

## Common Pitfalls

- **Using the package manager directly:** Do not use pnpm, npm, or Yarn directly. Vite+ can handle all package manager operations.
- **Always use Vite commands to run tools:** Don't attempt to run `vp vitest` or `vp oxlint`. They do not exist. Use `vp test` and `vp lint` instead.
- **Running scripts:** Vite+ commands take precedence over `package.json` scripts. If there is a `test` script defined in `scripts` that conflicts with the built-in `vp test` command, run it using `vp run test`.
- **Do not install Vitest, Oxlint, Oxfmt, or tsdown directly:** Vite+ wraps these tools. They must not be installed directly. You cannot upgrade these tools by installing their latest versions. Always use Vite+ commands.
- **Use Vite+ wrappers for one-off binaries:** Use `vp dlx` instead of package-manager-specific `dlx`/`npx` commands.
- **Import JavaScript modules from `vite-plus`:** Instead of importing from `vite` or `vitest`, all modules should be imported from the project's `vite-plus` dependency. For example, `import { defineConfig } from 'vite-plus';` or `import { expect, test, vi } from 'vite-plus/test';`. You must not install `vitest` to import test utilities.
- **Type-Aware Linting:** There is no need to install `oxlint-tsgolint`, `vp lint --type-aware` works out of the box.

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to validate changes.
<!--VITE PLUS END-->
