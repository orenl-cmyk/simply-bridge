ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4318 DATA_DIR=/app/data
COPY --chown=node:node *.mjs package.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node deploy/healthcheck.mjs ./deploy/healthcheck.mjs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "deploy/healthcheck.mjs"]
CMD ["node", "server.mjs"]
