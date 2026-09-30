# Simulator image for Cloud Run Jobs: `job --run <runId>` executes one run created from the research panel and exits.
# Build from the repository root (it needs shared/ and the models in functions/models/):
#   docker build -f simulator/Dockerfile -t simulator .
# The prepared signals are not in the image: the job downloads the ones of its run from SIM_DATA_URI (gs://...).
FROM node:22-slim

WORKDIR /app/simulator
COPY simulator/package.json simulator/package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY simulator/ ./
COPY shared/ /app/shared/
COPY functions/models/ /app/functions/models/

ENV NODE_OPTIONS=--enable-source-maps
ENTRYPOINT ["npx", "--no-install", "tsx", "src/cli.ts"]
# Without arguments it only lists the latest runs: the Function always passes `job --run <runId>`.
CMD ["status"]
