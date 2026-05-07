REPO_ROOT  := $(shell git rev-parse --show-toplevel)
IDL_SRC    := $(REPO_ROOT)/programs/agents-network/client/agents_network_client.idl
IDL_DST    := $(REPO_ROOT)/agent-starter/idl/agents_network_client.idl

.PHONY: sync-idl lint check-idl install-hook help

help:
	@echo "agent-starter targets:"
	@echo "  make sync-idl     copy IDL from programs/agents-network/client/ into idl/"
	@echo "  make check-idl    fail if idl/ differs from source (used by pre-commit hook)"
	@echo "  make install-hook install the pre-commit hook into .git/hooks/"
	@echo "  make lint         run lint.sh (frontmatter + bash -n + cross-link integrity)"

sync-idl:
	@if [ ! -f "$(IDL_SRC)" ]; then \
	  echo "ERROR: source IDL missing at $(IDL_SRC)"; \
	  echo "       build the program first: cd programs/agents-network && cargo build --release"; \
	  exit 1; \
	fi
	@mkdir -p $(REPO_ROOT)/agent-starter/idl
	@cp "$(IDL_SRC)" "$(IDL_DST)"
	@echo "IDL synced: $(IDL_DST) ($$(wc -c < $(IDL_DST)) bytes)"

check-idl:
	@if [ ! -f "$(IDL_DST)" ]; then \
	  echo "ERROR: agent-starter/idl/agents_network_client.idl missing — run 'make sync-idl'"; \
	  exit 1; \
	fi
	@if ! diff -q "$(IDL_SRC)" "$(IDL_DST)" >/dev/null 2>&1; then \
	  echo "ERROR: agent-starter/idl/ out of sync — run 'make sync-idl'"; \
	  exit 1; \
	fi

install-hook:
	@cp $(REPO_ROOT)/agent-starter/.pre-commit-hook $(REPO_ROOT)/.git/hooks/pre-commit
	@chmod +x $(REPO_ROOT)/.git/hooks/pre-commit
	@echo "Pre-commit hook installed: .git/hooks/pre-commit"

lint:
	@bash $(REPO_ROOT)/agent-starter/lint.sh
