# For Railway, Fly.io, Koyeb, a VPS, or anywhere else that runs containers.
# (Render uses render.yaml instead and does not need this file.)
FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./

ENV NODE_ENV=production \
    PORT=10000
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "server.js"]
