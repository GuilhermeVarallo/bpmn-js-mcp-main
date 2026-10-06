# syntax=docker/dockerfile:1
#
# bpmn-js-mcp em modo HTTP (MCP Streamable HTTP em :3000/mcp).
# NÃO publicar esta porta direto: o nginx de deploy/nginx é quem põe os
# cabeçalhos de segurança exigidos pelo ESI/FGV. Ver README.md.

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:22.22-alpine3.22 AS build
# bpmn-auto-layout e bpmn-to-image são dependências git (github:datakurre/...)
# compiladas no `npm ci` (script prepare): o build precisa de git e de acesso
# HTTPS a github.com.
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
COPY esbuild.config.mjs tsconfig.json tsconfig.mcp-apps.json ./
COPY src ./src
RUN npm ci && npm prune --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22.22-alpine3.22
ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3000
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.MCP_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js", "--http"]
