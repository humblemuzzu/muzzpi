#!/bin/bash
# list.sh <pi sessions dir> <root>...: "<unix time pi last ran there, or 0>\t<folder>" per project folder
sessions="$1"
shift
for root in "$@"; do
    [ -d "$root" ] || continue
    root="$(cd "$root" && pwd -P)"
    for dir in "$root"/*/; do
        [ -d "$dir" ] || continue
        dir="${dir%/}"
        encoded="${dir#/}"
        encoded="--${encoded//[\/:]/-}--"
        used=0
        [ -d "$sessions/$encoded" ] && used="$(stat -f %m "$sessions/$encoded")"
        printf '%s\t%s\n' "$used" "$dir"
    done
done
