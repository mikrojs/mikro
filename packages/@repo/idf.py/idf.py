#!/bin/sh
# Thin wrapper: runs idf.py via eim in the activated ESP-IDF environment.
# Usage: idf.py <args>
#   idf.py build
#   idf.py set-target esp32c6
#   idf.py build flash monitor
exec eim run "idf.py $*"
