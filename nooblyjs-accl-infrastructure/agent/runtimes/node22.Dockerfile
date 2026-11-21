# The node22 runtime (spec 8.3 R1). The agent fills the {{…}} slots (each a JSON string, so nothing in a command can
# break out of its line): BASE from bases.json, BUILD and START from the service's build and start commands or these
# defaults. Variables marked "available during the build" arrive as a BuildKit secret, sourced for the build command
# only, so none of them is written into a layer (R5).
FROM {{BASE}}
WORKDIR /app
COPY --chown=node:node . .
RUN --mount=type=secret,id=build-env ["/bin/sh", "-c", {{BUILD_WITH_ENV}}]
ENV HOME=/tmp NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false
USER node
CMD ["/bin/sh", "-c", {{START}}]
