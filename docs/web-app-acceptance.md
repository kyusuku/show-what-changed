# General web-app acceptance for revision 0.3

Status. Required acceptance contract. Final installed-candidate evidence is pending.

The tool compares browser applications through explicit recipes. Its npm distribution does not restrict target languages, frameworks, or package managers. This contract uses public, redistributable inputs. It does not depend on access to any private application.

## Compatibility matrix

| Application | Required behavior |
| --- | --- |
| Static site without package.json | Explicit host server, exact source comparison, normal browser motion |
| Root npm app | Frozen dependency setup, declared start command, a visible source change |
| pnpm workspace | Install at repository root, build and import shared packages, select one nested web app |
| Python app without package.json | Separate application runtime, declared setup/start, identical browser scenarios |
| Docker app and backing service | Pinned service image, side-isolated state, owned build/run resources, exact cleanup |

Every row must pass through the clean installed final package. Record source identity, recipe and scenario identities, command, tool/runtime versions, actual exit, media hashes, and cleanup. Success through source-tree imports does not satisfy installed-package acceptance. A generic recipe failure remains a product failure until resolved or explicitly documented as an unsupported boundary.

Generate an independent large source fixture with shared packages and more than 200 MiB of tracked data. Test full streaming inventories within the default 1 GiB budget, configured limits, copy races, source mutation, and caller preservation. Retain the generator and public input parameters rather than checking hundreds of megabytes into Git.

## Nontrivial public application

Select a publicly redistributable web application with normal user-facing routes. Record its license, upstream URL if applicable, exact commit, and bounded runtime prerequisites before execution. A repository maintained as a public example is eligible if it contains the actual navigation, inner scrolling, form state, and shared-package behavior being tested. A blank server or a replacement page written solely to bypass the chosen application's setup is insufficient.

Use no real accounts, production credentials, migrations against remote systems, paid providers, or real user data. If a service is replaced with a local inert dependency, disclose that boundary and preserve the public helper as a declared, digested recipe input. Runtime isolation and browser interception do not establish a hostile-code or network sandbox.

Keep recipes, scenarios, patches, and fixtures generic and redistributable. Public examples must not copy private application source, selectors, terminology, domain names, or identifiers.

## Required flows

1. Navigate a normal route at 390 by 844. Open and close an actual menu or panel, retain its intermediate motion, and scroll its inner content container. Independently verify that the inner container's scrollTop changes. Window-only scrolling does not satisfy this check.
2. Submit synthetic invalid form input and show actual validation feedback. Create an isolated candidate worktree with a visible feedback change. Capture the same normal-route flow before and after the change. Preserve the caller's checkout and index.

Readiness assertions and stable locators must come from the selected source. Keep each scenario within the supported action and duration bounds. Side-specific assertions are exclusions, not verified image pairs. Use a shared checkpoint for the changed feedback.

## Final candidate sequence

1. Install the exact candidate tarball into a clean tool directory and record its SHA-256.
2. Run doctor and inspect the plan using explicit source versions, recipe, and scenarios.
3. Execute both flows three consecutive times without manual repairs between runs.
4. Review source frames and final decoded media at normal playback speed. Verify actual intermediate motion, timing, narrow-view letterboxing, visible feedback change, and expected failure behavior.
5. Verify source/index/dependency preservation and absence of owned processes, workspaces, containers, and other resources after every run.
6. Save a literal public repeat command and exact inputs. Make a subsequent isolated local change and verify the documented WORKTREE comparison through that command.

G19 passes only with this evidence for the final installed candidate. G04 separately requires every compatibility-matrix row. Fixtures cannot prove universal compatibility, hosted authentication, external provider behavior, or untested application flows.

## Public release boundary

The source tree, package, demos, acceptance documents, and complete intended public Git history must contain no private application context. Run the release privacy scanner with an externally stored deny list, inspect public file names and media provenance, and review the exact source archive and package contents. A public test report must not include private deny-list values or private failure paths.

Private owner testing may continue separately under its own authorization. Store all private inputs and results outside this repository. It adds no private dependency to public CI or documentation and creates no permission to redistribute that material.
