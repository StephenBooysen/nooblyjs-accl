# The python312 runtime (spec 8.3 R1). Slots as in node22.Dockerfile. The default start runs gunicorn when the app
# installed it, else python app.py.
FROM {{BASE}}
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=build-env ["/bin/sh", "-c", {{BUILD_WITH_ENV}}]
ENV HOME=/tmp PYTHONUNBUFFERED=1
USER nobody
CMD ["/bin/sh", "-c", {{START}}]
