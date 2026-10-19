#!/usr/bin/env bash
# Observations only: do not alter scheduling, workload, budgets or gate status.
set -eu
date -u +%FT%TZ
for path in /proc/stat /proc/pressure/cpu /proc/self/cgroup; do
  echo "--- $path"
  if [ -r "$path" ]; then
    if [ "$path" = /proc/stat ]; then grep "^cpu" "$path"; else cat "$path"; fi
  else echo "unavailable"; fi
done
cgroup=$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)
if [ -n "$cgroup" ]; then
  for name in cpu.stat cpu.max; do
    path="/sys/fs/cgroup${cgroup%/}/$name"
    echo "--- $path"
    if [ -r "$path" ]; then cat "$path"; else echo "unavailable"; fi
  done
fi
