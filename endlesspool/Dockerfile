ARG BUILD_FROM
FROM ${BUILD_FROM}

# The HA base image uses s6-overlay as its entrypoint (/init).
# We don't need s6-overlay for a simple Python server, so clear it
# to avoid "s6-overlay-suexec: fatal: can only run as pid 1".
ENTRYPOINT []

RUN apk add --no-cache python3 py3-pip git jq

WORKDIR /app

# BUILD_VERSION is set by HA Supervisor from config.yaml's version field.
# Placing it before git clone ensures Docker busts the cache when version bumps.
ARG BUILD_VERSION
RUN git clone --depth 1 https://github.com/smash0190/endlesspool.git /tmp/src \
    && cp /tmp/src/server.py /tmp/src/strava.py /tmp/src/tcx.py /tmp/src/cli.py . \
    && cp /tmp/src/requirements.txt . \
    && cp -r /tmp/src/protocol ./protocol \
    && cp -r /tmp/src/static ./static \
    && rm -rf /tmp/src

RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
