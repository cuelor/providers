.PHONY: help ck-verify

help:
	@echo "make ck-verify   Run the repository checks (writes a JSON report to CK_TEST_REPORT when set)"

# The verification entry point. For now it only checks the repository skeleton; each part adds its checks
# to scripts/ck-verify.sh as it lands.
ck-verify:
	@sh scripts/ck-verify.sh
