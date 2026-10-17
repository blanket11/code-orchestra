#!/bin/bash
# Test stand-in for ffplay: swallows its arguments and writes the PCM stream to $SINK_OUT.
exec cat > "${SINK_OUT:-/dev/null}"
