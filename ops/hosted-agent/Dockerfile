# Build this image in a reviewed CI pipeline, inspect its digest, and set
# GATHERTHREAD_HOSTED_AGENT_IMAGE to its immutable local image ID or registry digest. Runtime containers
# receive no provider credential and have no general network interface.
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends socat git ca-certificates python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*
# Python works entirely within the disposable workspace. Third-party packages
# are not fetched at task runtime; local wheels may be installed in a venv.
ENV PYTHONDONTWRITEBYTECODE=1 PIP_NO_INDEX=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN npm install --global opencode-ai@1.18.32 && opencode --version
# Modules in /usr/local/lib resolve this private image dependency directly.
# Match the reviewed server lockfile; never rely on Node's implicit fetch pool.
RUN npm install --global undici@7.30.0 --ignore-scripts --no-audit --no-fund
# A private Git-less build uses umask 077. Public runtime modules still need
# deterministic read access for the non-root image user, independent of source modes.
COPY --chmod=0644 ops/hosted-agent/entrypoint.mjs /usr/local/lib/gatherthread-hosted-entrypoint.mjs
COPY --chmod=0555 ops/hosted-agent/cpuset-entrypoint.mjs /usr/local/lib/gatherthread-hosted-cpuset-entrypoint.mjs
COPY --chmod=0644 ops/hosted-agent/resource-check.mjs /usr/local/lib/resource-check.mjs
COPY --chmod=0644 ops/hosted-agent/public-answer.mjs /usr/local/lib/public-answer.mjs
COPY --chmod=0644 ops/hosted-agent/opencode-session.mjs /usr/local/lib/opencode-session.mjs
COPY --chmod=0644 ops/hosted-agent/live-output.mjs /usr/local/lib/live-output.mjs
COPY --chmod=0644 ops/hosted-agent/npm-setup.mjs /usr/local/lib/npm-setup.mjs
COPY --chmod=0644 ops/hosted-agent/runtime-environment.mjs /usr/local/lib/runtime-environment.mjs
RUN groupadd --gid 10001 agent && useradd --uid 10001 --gid 10001 --home-dir /home/agent agent
USER 10001:10001
RUN python3 --version && python3 -m pip --version && node --version && npm --version && git --version
WORKDIR /workspace
ENTRYPOINT ["node", "/usr/local/lib/gatherthread-hosted-entrypoint.mjs"]
