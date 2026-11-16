# Airlock relay — single-stage image for Render / Fly.io / Koyeb / Railway.
# Build from the repository root: docker build -t airlock-relay .
FROM node:22-alpine

WORKDIR /app

# The relay only needs `ws`; keeping the install tiny speeds up cold starts.
COPY apps/relay/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY apps/relay/server.mjs ./

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
