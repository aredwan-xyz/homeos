CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS readings (
  time        TIMESTAMPTZ      NOT NULL,
  room        TEXT             NOT NULL,
  device      TEXT             NOT NULL,
  measurement TEXT             NOT NULL,
  value       DOUBLE PRECISION NOT NULL
);

SELECT create_hypertable('readings', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_readings_rmt
  ON readings (room, measurement, time DESC);

CREATE MATERIALIZED VIEW IF NOT EXISTS readings_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', time) AS bucket,
       room, device, measurement,
       avg(value) AS avg_value,
       min(value) AS min_value,
       max(value) AS max_value
FROM readings
GROUP BY bucket, room, device, measurement
WITH NO DATA;

SELECT add_continuous_aggregate_policy('readings_1m',
  start_offset      => INTERVAL '1 hour',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE);
