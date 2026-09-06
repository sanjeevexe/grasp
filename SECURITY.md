# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Instead, use
[GitHub's private vulnerability reporting](https://github.com/sanjeevexe/grasp/security/advisories/new)
and include:

- the affected command or component;
- steps to reproduce the issue;
- the impact you believe it has;
- any suggested mitigation, if you have one.

Reports involving command execution, path traversal, Git-hook safety, credential
handling, source-code disclosure, or sensitive log output are especially useful.
You will receive an acknowledgement through the advisory thread, and fixes will
be coordinated there before public disclosure.

## Supported versions

Until Grasp has a stable release, security fixes are applied to the latest
commit on `main` only.
