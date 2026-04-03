#!/bin/sh
set -e

systemctl stop vocipher.service 2>/dev/null || true
systemctl disable vocipher.service 2>/dev/null || true
