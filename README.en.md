<div align="center">
  <img src="docs/assets/brand/png/agint-logo-512.png" width="300" alt="AGINT">
</div>

# AGINT

English | [中文](README.md)

> A **self-evolving agent framework** built on DeepSeek Harness (`dsh`).

**v0.15.0** · 40 Cordis plugins (36 mount declarations) · 1 preset · 25 preset tool rows · 27 cron jobs. For live numbers, see the LOCAL-STATE block at the end of [`AGENTS.md`](./AGENTS.md).

- **Philosophy**: beauty = simple + true + dependable + proactive + safe. When two of these conflict, the earlier one wins. Full text: Wiki [PHILOSOPHY](https://github.com/Anmulzhao/DSH-AGINT/wiki/PHILOSOPHY).
- **Position**: `dsh` is the upstream runtime. AGINT is a specification plus a component set on top of it. It is not a fork. AGINT is not an AGI implementation. It is the engineering skeleton that leads toward AGI: memory, reflection, constraints, metrics, evaluation. Every new feature must pass D-QAF evaluation.
- **Constitution**: the D-QAF four-stage pipeline, the HARM four-dimension metrics, and the evolution memory layer. See [`docs/evolution-framework.md`](./docs/evolution-framework.md). Automation is the default. Human approval is only a fallback. Every new mechanism ships with a kill-switch, enabled out of the box, with a configured degraded fallback and an audit exit.

## Four layers

| Layer | Content | Location |
|---|---|---|
| **bundle** | The whole: the `dsh` bundle package `@agint/host` (all plugins plus mount patches) | `package.json` + `cordis.patch.yml` |
| **preset** | The Zhinjin (智进) persona, its tool set, and its skills; 1 preset: `agint` (main line) | `presets/agint/` |
| **plugin** | 40 Cordis plugins (36 mount declarations) in 8 groups (memory / scheduling / reflection / quality / closed loop / execution / observation / perception). List: [`docs/plugins/`](./docs/plugins/) | `plugins/agint-*/` |
| **data** | Memory / rules / metrics / dreams / reviews | Runtime data. It does not enter the repository. |

## Install

Prerequisites: Node.js ≥ 20 · python3 · `dsh` ≥ 0.1.7-rc.1 (matrix in [`VERSION`](./VERSION)) · the target profile is initialized (run `dsh web` once for web, or launch the desktop app once for desktop).

```sh
git clone https://github.com/Anmulzhao/DSH-AGINT.git ~/projects/AGINT
cd ~/projects/AGINT
./install/install.sh --profile=web      # web is the default; use --profile=desktop for the desktop profile
```

After the install, **restart the target profile** (re-open `dsh web`, or quit and re-open the desktop app). The bundle layer and the profile layer do not hot-reload. To remove AGINT, run `./install/uninstall.sh`.

> **One preset serves every profile**: `$DSH_HOME/.agent-presets/agint/` holds a
> single file set shared by web and desktop. Its 25 tool declarations therefore
> anchor to `.agint-bundle/plugins/` (the bundle's main mount source) and do
> **not** vary with `--profile` — installing web and then desktop will not point
> the first one at an empty directory. The installer verifies all 25 targets
> exist and reports any that are missing.

Four hard rules:

1. Always name the exact version when you upgrade `dsh`. `npm i -g @deepseek-ai/dsh@latest` silently downgrades.
2. The `node_modules` entry inside the package is a junction to the official `dsh` package. `rm -rf` follows the link and deletes that package. Keep it when you uninstall.
3. If the install ends with no error but nothing looks installed, the bundle is most likely not registered in `dsh.profile.bundles` (install step 3.5).
4. `!!js` in `cordis.patch.yml` must be a scalar. A block collection or a template makes the whole bundle patch fail to parse. `dsh` then silently skips `@agint/host`, and the UI shows no error. Run `node bin/check-patch-yaml.mjs` after you edit the file.

For more troubleshooting, see [`docs/dsh-integration.md`](./docs/dsh-integration.md). For container deployment, use [`docker/`](./docker/).

## Repository self-checks

After you change a plugin, run four steps: `node bin/check-patch-yaml.mjs` (the patch YAML parses) → `node bin/check-wiring.mjs` (the wiring is live) → `node bin/check-dsh-compat.mjs` (`dsh` compatibility) → `node bin/check-boundary.mjs` (the capability boundary is clean). The other self-checks (manifest / tool schema / memory layer / LOCAL-STATE write-back) carry their own usage notes in the scripts under `bin/`.

## Documentation map

| What you want | Where to go |
|---|---|
| Runtime state (real numbers, authoritative) | The LOCAL-STATE block at the end of [`AGENTS.md`](./AGENTS.md) |
| Architecture / plugin detail | [`docs/architecture.md`](./docs/architecture.md) · [`docs/plugins/`](./docs/plugins/) |
| `dsh` integration / install troubleshooting | [`docs/dsh-integration.md`](./docs/dsh-integration.md) |
| Security boundary / kill-switch list | [`docs/security-boundary.md`](./docs/security-boundary.md) |
| Capability ownership / boundary rules | [`docs/capability-boundary.md`](./docs/capability-boundary.md) |
| **Known gaps (read this before you draw a conclusion)** | [`docs/known-limitations/`](./docs/known-limitations/) |
| Ops SOP / pitfall records / evaluation scenarios | [`docs/operations/`](./docs/operations/) · [`docs/lessons/`](./docs/lessons/) · [`eval/scenarios/`](./eval/scenarios/) |
| Roadmap / changelog / PHILOSOPHY | [GitHub Wiki](https://github.com/Anmulzhao/DSH-AGINT/wiki) |

Docs under `docs/` are written in Chinese. This README is the only English entry point.

Three environment variables: `DSH_HOME` (the `dsh` data root, default `$HOME/.dsh`); `AGINT_PROFILE` (the default target profile for `install.sh`, `web` if unset); `AGINT_HOME`, which has **two meanings** — `install.sh` reads it as the source root, while plugins read it as the data root. Set it wrong and the system writes data into the repository directory. The design note is in `docker/entrypoint.sh`.

## License

MIT
