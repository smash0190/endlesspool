ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache python3 py3-pip git jq

WORKDIR /app

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
