FROM igorhvr/bedlam-ubuntu
MAINTAINER Igor Hjelmstrom Vinhas Ribeiro <igorhvr@iasylum.net>

# ============================================================================
# ADDITIONS: hermes, pi, dsh (DeepSeek Harness), tamandua
# ============================================================================
# The base above already provides git, curl, node v24, npm 11, python3, and a
# functional nix profile (/root/.nix-profile). Tooling preference order: nix,
# then apt-get, then other methods. hermes ships its own managed uv; pi is an
# npm package; dsh builds from its repo with the repo-pinned pnpm; tamandua
# builds from source via its documented installer. No nix package is strictly
# required by any of the four tools, so precedence went to the package manager
# already present (npm/corepack) and to hermes' own managed uv. All installers
# run non-interactively (no TTY in the build VM).

# Runtime shell (matchlock exec/run) must resolve every tool. Set HOME=/root so
# $HOME-relative paths ($HOME/.local/bin via tamandua, $HOME/.hermes via hermes,
# $HOME/.nix-profile via nix) land where the installers write. Put nix on PATH
# too (the base's profile is real and executable).
ENV PATH="/usr/local/bin:/root/.local/bin:/root/.hermes/bin:/root/.nix-profile/bin:$PATH"
ENV HOME="/root"

# --- hermes (uv-managed venv; skip setup wizard, browser, computer-use) ---
# --non-interactive never blocks on prompts; --skip-setup skips the API-key
# wizard (no credentials baked into the image); --skip-browser and
# --skip-computer-use skip the heavy Playwright/chromium + computer-use pulls.
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
  | bash -s -- --non-interactive --skip-setup --skip-browser --skip-computer-use

# --- pi (npm package; auto-installs when no TTY) ---
RUN curl -fsSL https://pi.dev/install.sh | sh

# --- dsh / DeepSeek Harness (build from the official repo, pinned pnpm) ---
RUN npm install -g pnpm@11.7.0 \
 && git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git /opt/dsh \
 && cd /opt/dsh \
 && pnpm install --frozen-lockfile \
 && pnpm run build \
 && ln -sf /opt/dsh/apps/cli/lib/bin.js /usr/local/bin/dsh

# --- tamandua (Node >=22; documented installer builds + symlinks) ---
RUN git clone --depth 1 https://github.com/igorhvr/tamandua.git /opt/tamandua \
 && bash /opt/tamandua/scripts/install.sh --local /opt/tamandua

# --- verify all four entrypoints resolve on PATH (fail the build if any is missing) ---
RUN set -eu; for t in hermes pi dsh tamandua; do command -v "$t"; done
