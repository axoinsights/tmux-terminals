# Sandbox option: run agent-terminal (and the agents it launches) inside a container.
# The native install is the main path (see README.md); use this when you want the agents confined
# to a container and a mounted workspace instead of your whole home directory.
#
#   docker compose up -d --build
#   docker compose exec agent-terminal agent-terminal token --url
#
# Extra agent CLIs can be baked in with a build arg, e.g.
#   docker build --build-arg NPM_AGENTS="@anthropic-ai/claude-code @openai/codex" -t agent-terminal .
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm ci --ignore-scripts && npx tsc && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git openssl ca-certificates tini less procps \
 && rm -rf /var/lib/apt/lists/*
ARG NPM_AGENTS=""
RUN if [ -n "$NPM_AGENTS" ]; then npm install -g $NPM_AGENTS; fi
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json tmux.conf ./
COPY bin ./bin
COPY web ./web
RUN mkdir -p /workspace && chown node:node /workspace
USER node
ENV HOME=/home/node \
    AGENT_TERMINAL_HOST=0.0.0.0 \
    AGENT_TERMINAL_PORT=8767 \
    AGENT_TERMINAL_TLS=off
WORKDIR /workspace
VOLUME ["/workspace", "/home/node/.config/agent-terminal"]
EXPOSE 8767
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8767/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "node", "/app/bin/agent-terminal.mjs"]
CMD ["start"]
