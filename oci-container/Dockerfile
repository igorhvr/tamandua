FROM igorhvr/bedlam-ubuntu@sha256:adc1ee27af2a29e76dc12a5613193d52195ec6e952da8523717c5b18044d7841 AS icebox-env
MAINTAINER Igor Hjelmstrom Vinhas Ribeiro <igorhvr@iasylum.net>

# ============================================================================
# [r4] standard matchlock image: tamandua + dsh + pi + hermes.
#
# pi and hermes are BUILT FROM SOURCE. Their main-tracked git clones live in
# the image at /opt/src/{pi,hermes-agent} next to a ./build-and-install script:
# edit the source, rerun the script, and the running version is yours. The
# image itself is built by running those same scripts (one code path).
#
# Frozen source SHAs for r4 (also recorded in /etc/tamandua-image-manifest.json
# and the OCI labels below; users can `git pull` ahead of them at will):
#   hermes-agent: 2943ee6f19a2abd0cc93384db55643469e80dfcb
#   pi:           f10993bc7f28145df1375f3ff39c7f5c4cfc05f0
#   dsh:          5badb15009ae1756c3afe0ae0cef1faafc290ccc
#   tamandua:     cf2e6c3a8737ac561f2ed71353f5627a408caa89
# Python runtime pin: 3.14.7 -- the NEWEST Python hermes main supports
# (`requires-python >=3.11,<3.15`; upstream's own pm/lock.json names the exact
# 3.14.7+20260901 artifact). Newest-supported is deliberate: older Pythons
# previously caused sqlite corruption for the maintainer.
# ============================================================================

LABEL org.opencontainers.image.title="tamandua standard image (r4)" \
      org.opencontainers.image.source="https://github.com/igorhvr/tamandua" \
      org.opencontainers.image.description="Matchlock standard image: tamandua, dsh, pi and hermes (pi/hermes built from in-image source with build-and-install scripts)" \
      com.tamandua.hermes.commit="2943ee6f19a2abd0cc93384db55643469e80dfcb" \
      com.tamandua.pi.commit="f10993bc7f28145df1375f3ff39c7f5c4cfc05f0" \
      com.tamandua.dsh.commit="5badb15009ae1756c3afe0ae0cef1faafc290ccc" \
      com.tamandua.tamandua.commit="cf2e6c3a8737ac561f2ed71353f5627a408caa89" \
      com.tamandua.python.pin="3.14.7"

# User-agnostic PATH: everything the image runs for any caller uid lives under
# /usr/local (never behind /root) or /nix (a world-readable store). The nix
# profile bin is FIRST so interactive sessions (which forward the image PATH
# verbatim) and every child process (pi/hermes/...) see nix, uv and yggdrasil
# without any shell rc.
ENV PATH="/nix/var/nix/profiles/default/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV HOME="/root"

# --- [icebox] Tier-A environment + passwordless-sudo drop-in (design v6 §2) --
# One shared env stage. `docker build --target icebox-env` builds exactly this
# layer (pinned base + Pillar A/B contents) for the disposable-container
# acceptance run (oci-container/icebox/verify-icebox-env.sh); the production
# stages below inherit it. The installer is idempotent and fail-closed:
# oci-container/icebox/pillar-a/apply.sh.
COPY icebox/pillar-a /opt/icebox/pillar-a
RUN bash /opt/icebox/pillar-a/apply.sh

# --- production stages: standard image (tamandua + dsh + pi + hermes) --------
FROM icebox-env

# --- native toolchain: pi's optional TUI native helpers need a C compiler +
# --- libxcb; pkg-config/make cover source rebuilds of either tool by users. --
RUN apt-get -o Acquire::Retries=3 update \
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      build-essential pkg-config libxcb1-dev \
 && rm -rf /var/lib/apt/lists/*

# --- hermes-agent: main-tracked source clone + build-and-install -------------
# The data root (store + venv generations) lives at /opt/src/hermes-root, and
# /opt/src/manifest.json + /opt/src/hermes-venv make the built application
# environment selectable for ANY caller uid and ANY HERMES_HOME (the guest
# contract); install-stamp.json marks the install externally updated. See
# build-and-install-hermes.sh.
RUN set -eu; \
    ok=""; \
    for i in 1 2 3 4 5; do \
      rm -rf /opt/src/hermes-agent; \
      if git clone https://github.com/NousResearch/hermes-agent.git /opt/src/hermes-agent; then ok=1; break; fi; \
      sleep 10; \
    done; \
    [ -n "$ok" ]; \
    git -C /opt/src/hermes-agent checkout -B main 2943ee6f19a2abd0cc93384db55643469e80dfcb; \
    git -C /opt/src/hermes-agent branch --set-upstream-to=origin/main main

COPY build-and-install-hermes.sh /opt/src/hermes-agent/build-and-install
RUN printf 'build-and-install\n' >> /opt/src/hermes-agent/.git/info/exclude \
 && chmod 755 /opt/src/hermes-agent/build-and-install \
 && EXPECT_HEAD=2943ee6f19a2abd0cc93384db55643469e80dfcb \
    HERMES_SYSTEM_HOME=/opt/src/hermes-root \
    TAMANDUA_IMAGE_BUILD=1 \
    /opt/src/hermes-agent/build-and-install

# --- pi: main-tracked source clone + build-and-install -----------------------
RUN set -eu; \
    ok=""; \
    for i in 1 2 3 4 5; do \
      rm -rf /opt/src/pi; \
      if git clone https://github.com/earendil-works/pi.git /opt/src/pi; then ok=1; break; fi; \
      sleep 10; \
    done; \
    [ -n "$ok" ]; \
    git -C /opt/src/pi checkout -B main f10993bc7f28145df1375f3ff39c7f5c4cfc05f0; \
    git -C /opt/src/pi branch --set-upstream-to=origin/main main

COPY build-and-install-pi.sh /opt/src/pi/build-and-install
RUN printf 'build-and-install\n' >> /opt/src/pi/.git/info/exclude \
 && chmod 755 /opt/src/pi/build-and-install \
 && TAMANDUA_IMAGE_BUILD=1 EXPECT_HEAD=f10993bc7f28145df1375f3ff39c7f5c4cfc05f0 /opt/src/pi/build-and-install

# --- dsh / DeepSeek Harness (same shape as the previous image; pinned) -------
RUN set -eu; \
    ok=""; \
    for i in 1 2 3 4 5; do \
      rm -rf /opt/dsh; \
      if git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git /opt/dsh; then ok=1; break; fi; \
      sleep 10; \
    done; \
    [ -n "$ok" ]; \
    if [ "$(git -C /opt/dsh rev-parse HEAD)" != "5badb15009ae1756c3afe0ae0cef1faafc290ccc" ]; then \
      git -C /opt/dsh fetch --depth 1 origin 5badb15009ae1756c3afe0ae0cef1faafc290ccc; \
      git -C /opt/dsh checkout --detach 5badb15009ae1756c3afe0ae0cef1faafc290ccc; \
    fi; \
    npm install -g pnpm@11.7.0; \
    cd /opt/dsh; \
    pnpm install --frozen-lockfile; \
    pnpm run build; \
    ln -sf /opt/dsh/apps/cli/lib/bin.js /usr/local/bin/dsh; \
    chmod -R a+rX /opt/dsh

# --- tamandua (pinned source + launcher on the shared PATH) ------------------
RUN set -eu; \
    ok=""; \
    for i in 1 2 3 4 5; do \
      rm -rf /opt/tamandua; \
      if git clone --depth 1 --branch main https://github.com/igorhvr/tamandua.git /opt/tamandua; then ok=1; break; fi; \
      sleep 10; \
    done; \
    [ -n "$ok" ]; \
    if [ "$(git -C /opt/tamandua rev-parse HEAD)" != "cf2e6c3a8737ac561f2ed71353f5627a408caa89" ]; then \
      git -C /opt/tamandua fetch --depth 1 origin cf2e6c3a8737ac561f2ed71353f5627a408caa89; \
      git -C /opt/tamandua checkout --detach cf2e6c3a8737ac561f2ed71353f5627a408caa89; \
    fi; \
    git -C /opt/tamandua rev-parse HEAD; \
    bash /opt/tamandua/scripts/install.sh --local /opt/tamandua; \
    ln -sfn /opt/tamandua/bin/tamandua /usr/local/bin/tamandua; \
    ln -sfn /opt/tamandua/bin/tamandua-test /usr/local/bin/tamandua-test; \
    chmod -R a+rX /opt/tamandua

# --- provenance: /etc/tamandua-image-manifest.json ---------------------------
COPY provenance.sh /usr/local/sbin/tamandua-image-provenance
RUN chmod 755 /usr/local/sbin/tamandua-image-provenance \
 && /usr/local/sbin/tamandua-image-provenance

# --- verify all entrypoints resolve on PATH and the manifest is valid JSON ---
RUN set -eu; for t in hermes hermes-acp pi dsh tamandua; do command -v "$t"; done; \
    python3 -c "import json;json.load(open('/etc/tamandua-image-manifest.json'))" \
 && echo "image-manifest-ok"

# --- ssh hygiene: do not inherit the base's baked host identity / root grant --
# The base image deliberately bakes ssh host keys (/etc/ssh/ssh_host_*_key and
# their .pub files) and a root /root/.ssh/authorized_keys for its own use. A
# derived image otherwise inherits those bytes verbatim, so every consumer
# would share the same "private" host key (shipping inside a public image) and
# inherit a root access grant. Remove exactly those seven files — /root/.ssh
# itself is legitimate and stays. Never generate keys here: build-time
# generation would only re-bake the same class of problem; first-boot
# generation is the caller's job. Removal and the fail-closed absence check
# live in ONE layer so no intermediate layer can resurrect the files.
RUN rm -f /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub \
          /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub \
          /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub \
          /root/.ssh/authorized_keys \
 && for f in /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub \
             /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub \
             /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub \
             /root/.ssh/authorized_keys; do \
      test ! -e "$f" || { echo "image hygiene: $f still present" >&2; exit 1; }; \
    done
