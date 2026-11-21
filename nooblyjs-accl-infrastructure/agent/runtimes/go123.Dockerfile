# The go123 runtime (spec 8.3 R1): built with the Go toolchain, run on slim Debian (two stages, so the toolchain is not
# in the image). Slots as in node22.Dockerfile; RUN_BASE is the second stage's base.
FROM {{BASE}} AS build
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=build-env ["/bin/sh", "-c", {{BUILD_WITH_ENV}}]

FROM {{RUN_BASE}}
WORKDIR /app
COPY --from=build /app /app
ENV HOME=/tmp
USER nobody
CMD ["/bin/sh", "-c", {{START}}]
