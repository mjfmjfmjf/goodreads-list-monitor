#!/bin/bash
cat ~/.zsh_history | grep udit | grep tag-audit | sed 's/.*npm/npm/' | sort | uniq -c
