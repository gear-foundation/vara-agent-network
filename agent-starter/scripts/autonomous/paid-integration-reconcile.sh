#!/usr/bin/env bash
# scripts/paid-integration-reconcile.sh — recovery-scan entry to reconcile
# a single pending call by message id.
#
# This is a thin wrapper over payment-reconciliation.sh, kept as its own
# script so the autonomous loop's recovery scan has an unambiguous entry
# point that's distinct from the "reconcile the next pending" tick path.
#
# Usage:
#   bash paid-integration-reconcile.sh --message-id <0xhex>
#
# The wrapper exists so the autonomous loop's recovery scan code reads
# more clearly. All the logic lives in payment-reconciliation.sh.
#
# Source: source lib/status.sh so any pre-arg-validation failure still
# emits a JSON status line.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/status.sh
source "$SCRIPT_DIR/lib/status.sh"

setup_status_trap

MSG_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --message-id) MSG_ID="$2"; shift 2 ;;
    --help|-h)    sed -n '2,15p' "$0"; exit 0 ;;
    *) status_err "OPERAND" "unknown arg '$1'" ;;
  esac
done

[[ -n "$MSG_ID" ]] || status_err "OPERAND" "--message-id is required"

# Hand off to payment-reconciliation.sh. It carries the audit gate, the
# read-only invariant, and the rename + decision-move logic.
exec "$SCRIPT_DIR/payment-reconciliation.sh" --message-id "$MSG_ID"
