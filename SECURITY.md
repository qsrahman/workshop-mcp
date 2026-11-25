# Security policy

## Reporting a vulnerability

Please report it privately, not in a public issue: open a [private security advisory](https://github.com/qsrahman/workshop-mcp/security/advisories/new) on this repository. Include the version (`npm view @qsrahman/workshop-mcp version` shows the latest), the flags the server was started with, and steps to reproduce.

This is a one-person project, so replies are best effort. I aim to acknowledge a report within a week and to fix a confirmed problem in the next release, crediting you if you wish.

## Supported versions

Only the latest release gets fixes. Update with `npx -y @qsrahman/workshop-mcp@latest`, or reinstall.

## What counts as a vulnerability

The [security model in the README](README.md#security-model) says what the server promises. In scope:

- **Symlink handling.** A file tool writing through a symlink, or reading one that was swapped in after the path was resolved.
- **`fetch_url` address policy.** Reaching a private, loopback, link-local or metadata address without `--allow-private-ips`, including through a redirect, a DNS answer that changes (rebinding), or an unusual spelling of an address. Also fetching a host outside `--allowed-hosts`, or ignoring `robots.txt` without `--ignore-robots-txt`.
- **Resource limits.** A page or response that makes the server hang or use unbounded memory despite the size, depth and time limits.
- **Secrets.** `BRAVE_API_KEY` appearing in a tool result, an error, a URL, a log line, or the shell's environment.
- **The release pipeline.** A way to publish to npm, or to alter a published release, without going through the release workflow.

## What does not

These are documented behaviour, not vulnerabilities:

- **No sandbox.** The file tools and the shell can reach anything the user running the server can, and the server has no option that restricts them. Use a restricted user or a container.
- **Prompt injection through web text.** A fetched page or search result can try to steer the model. The server labels such text as untrusted, but it cannot stop a model from following it. `--allowed-hosts`, your client's tool approvals, and running the server as a restricted user or in a container limit what an injection can do.
- **The known gaps** listed under "Limits of the checks" in the README: Windows and WSL path handling.
- Behaviour of the MCP client or the model that is using the server.

If you are unsure which side a finding is on, report it anyway.
