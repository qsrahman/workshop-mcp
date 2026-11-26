# workshop-mcp

A small [Model Context Protocol](https://modelcontextprotocol.io) server that gives an MCP client tools to read, write and edit files, run shell commands, fetch web pages and (with a Brave API key) search the web. It serves over stdio.

**It is not restricted to any directory, and it always serves the shell.** There are no switches that take file or shell access away. See [Security model](#security-model) before pointing it at a model you do not fully trust.

> **Formerly `@qsrahman/fs-mcp-server`.** That name described only the file tools; the package was renamed when the web tools arrived. The old package is deprecated and stays at 0.2.0. To switch, replace `@qsrahman/fs-mcp-server` with `@qsrahman/workshop-mcp` in your client configuration; the command it installs is now `workshop-mcp`.

## Tools

| Tool                  | What it does                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`           | Read a text file. Output is capped at about 100,000 characters; a longer file ends with the offset to continue from. `offset` and `limit` read a range of lines, `head` / `tail` the first / last N lines (use only one of the three). Directories, binary files and invalid UTF-8 near the start of a file are refused with a clear message; edits check the whole file. |
| `read_multiple_files` | Read up to 50 files at once, about 200,000 characters in total (a file that does not fit is cut, with where to continue). A failure on one file is reported inline and does not stop the others.                                                                                                                                    |
| `write_file`          | Create a file or overwrite it completely, creating any missing parent directories.                                                                                                                                                                                                                                                  |
| `edit_file`           | Apply ordered `{oldText, newText}` edits and return a git-style diff. Each `oldText` must match exactly one place unless `replaceAll` is set. `dryRun` previews without writing.                                                                                                                                                    |
| `shell`               | Run a shell command; returns its output as plain text, starting with the exit code when it fails and labelling stderr when there is any. Always served (see Security model).                                                                                                                                                                                                                |
| `fetch_url`           | Fetch a web page and return its readable content as markdown, in parts for a long page. Refuses private and local addresses, and obeys `robots.txt`.                                                                                                                                  |
| `web_search`    | Search the web with Brave Search; returns a numbered list of results (title, source, age, URL, description). **Only offered when `BRAVE_API_KEY` is set** (see Web search).                                                                                                                                                         |

### For agents

The server sends MCP `instructions` when a client connects: that file access is not restricted, how relative paths resolve, and advice to read before editing, to prefer `edit_file` over `write_file`, and to look around with `ls`, `find` and `grep` in the shell. Errors name the path as the client wrote it (`File not found: src/a.ts`, `src is a directory, not a file`). Tool inputs are strict: an unknown or misspelled argument (for example `start_line` for `offset`) is an error that names it, not something silently ignored. Every parameter has a description. The tool list never changes while the server runs, so it is announced with `listChanged: false`, and a client on the 2026-07-28 protocol revision may cache it for five minutes. A call whose arguments hold more than 5,000 array elements and object members combined (about 1,600 edits) is rejected before it runs; string contents such as a file's text do not count.

### Fetching web pages

`fetch_url` fetches a URL and returns the page's main content as markdown, without the navigation and footers. It needs no key, and is the natural partner of `web_search`: search to find a page, fetch to read it.

- It asks the site for markdown first and returns markdown as it is, otherwise it extracts the article from the HTML (with Mozilla's Readability) and converts it. `raw: true` returns the source instead. Text such as JSON passes through; images, PDFs and other binary content are refused.
- A long page is cut at `max_length` characters (default 20,000), and the result says which `start_index` to continue from. The page is kept in memory for five minutes, so reading the rest does not fetch it again.
- It sends an honest `User-Agent` (`workshop-mcp/<version>`) and **obeys `robots.txt`**, on every redirect hop. A site that forbids automated access, or whose `robots.txt` cannot be read, is refused with a message that tells the model to let you know. `--ignore-robots-txt` turns that off.
- **Private and local addresses are refused**: loopback (`localhost`, `127.0.0.1`), private ranges, link-local and cloud metadata addresses such as `169.254.169.254`, however they are spelled, and after every redirect. The check is made at the moment of connecting, so a host name cannot answer differently the second time. Fetching your own dev server needs `--allow-private-ips`.
- `--allowed-hosts example.com,*.docs.example.org` limits fetching to those hosts (an exact host, or `*.domain` for any subdomain but not the domain itself), for every request including `robots.txt` and redirects.
- Responses are read up to 5 MiB (counted after decompression), with a 30 second default timeout per request, and at most 10 redirects. Only the first 1.5 million characters of a very large HTML page are converted, because conversion runs on the server's main thread.
- The content is untrusted text from third parties; see [Security model](#security-model).

### Web search (optional)

`web_search` searches the web through the [Brave Search API](https://brave.com/search/api/). It is offered only when the `BRAVE_API_KEY` environment variable is set, so without a key nothing changes. Create a key in the [Brave Search API dashboard](https://api-dashboard.search.brave.com/app/keys) and give it to the server through your client's `env` setting (examples below), not on the command line, where it would show in process listings.

- It takes a `query` and, optionally, `count`, `offset` (pages), `freshness` (`pd`, `pw`, `pm`, `py`, or a date range), `country`, `search_lang` and `safesearch`. Results come back as a short numbered list to keep them cheap in tokens. Snippets are requested without highlight markup.
- The results are untrusted third-party text, and the key needs care; see [Security model](#security-model).
- Brave's free plan allows about one request per second. A rate-limit answer that resets within five seconds is waited out and retried once; a longer one, such as a used-up monthly quota, is reported as an error that says when it resets. Your search queries go to Brave.

### Edit behaviour

- Edits apply in order, each to the result of the previous one. `oldText` must match exactly one place: if it matches several, the edit fails and lists the line numbers, so add surrounding lines to make it unique or set `replaceAll: true` to replace every match.
- If there is no exact match, whole lines are matched ignoring leading and trailing whitespace, and the replacement takes the file's indentation.
- If any edit has no match or an ambiguous one, nothing is written.
- Writes and edits to the same file are serialized, so parallel calls cannot overwrite each other's changes.
- Line endings are preserved for files that use LF or CRLF consistently. A file with mixed endings is rewritten with its more common one (LF on a tie).
- Files that are not valid UTF-8 are refused, so their bytes are never rewritten. An empty `oldText` is rejected.
- A failed match reports which edit failed and quotes the closest lines of the file, numbered, with the first differing line, so the edit can be retried accurately.

## Security model

**There is no sandbox.** The file tools and the shell can reach anything the user running the server can: your home directory, SSH keys, credentials, other projects. The shell can also run any program and use the network. Use this server only with a client and model you trust, ideally as a restricted user or inside a container. The server has no option that takes file or shell access away; what you can control is where it runs and, for the web, what it may fetch:

| You want                                          | Do                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| the model kept away from some files and commands  | run the server as a restricted user, or in a container with only the directories it should see |
| fetching only from some sites                     | start the server with `--allowed-hosts a.com,*.b.org`                                          |
| one tool unavailable, or approved call by call    | use your MCP client's own per-tool settings; the server always serves all of them              |

### File tools

- Paths are resolved to their real location before use, so a symlink is followed to the file it points to, and relative paths resolve against the server's working directory. `~` is expanded to your home directory.
- `write_file` creates files exclusively and never writes through a symlink, and refuses to overwrite anything that is not a regular file. Reads open the file with `O_NOFOLLOW` too, so a symlink swapped in after the path was resolved is refused. Missing parent directories are created below the nearest existing ancestor.
- `edit_file` refuses a file that is not valid UTF-8 text anywhere in it, so a rewrite can never turn stray bytes into replacement characters. Reads only check the start of a file, so a log with one stray byte can still be read.

### Fetching web pages

`fetch_url` can request any public URL, which makes it a way for data to leave the machine: a page the model reads may carry hidden instructions telling it to read a file and put the contents in a URL it then fetches. The server cannot tell such a request from a legitimate one. The protections are the ones that limit what the model can do or reach: `--allowed-hosts` (the strongest, since an unlisted host is never contacted), and keeping private data out of reach by running the server as a restricted user or in a container.

Separately, the address check keeps `fetch_url` from being used against services on your own machine or network (the classic server-side request forgery): see Fetching web pages under Tools. It does not defend against a malicious page, only against being aimed inward.

### Web search

`web_search` sends queries to Brave and returns web text the model then reads. The text is untrusted, so a page can try to steer the model. The server tells the model not to follow it, which is a mitigation, not a boundary; what limits the damage is what the model is allowed to do next (your client's tool approvals, and where the server runs).

The API key is held only in the server's memory and the `X-Subscription-Token` header of the request to Brave; it is never returned by a tool and is removed from the shell's environment. Since file access is unrestricted, though, the model can read any file you can, including a client config file that contains the key. If the key must stay out of reach, run the server as a user who cannot read that file, or in a container.

### Shell tool

`shell` is always served. **It is not sandboxed:** the command can read, write and delete anything the server process can, and can use the network. Its starting directory (`cwd`) defaults to the server's working directory and can be any directory.

Commands run with stdin closed, are killed (with the processes they started) after `timeoutMs` (default 30 s, `0` disables) or when the request is cancelled, and each of stdout and stderr is cut to 20,000 characters (start and end kept). Terminal escape sequences are stripped and binary output is replaced by a note. A non-zero exit is returned as a result with `isError` set. The `BRAVE_API_KEY` environment variable is not passed to commands, but **every other variable of the server's environment is**, so the model can read, for example, a `GITHUB_TOKEN` or `AWS_SECRET_ACCESS_KEY` that your client sets in the server's `env`, with a plain `env` command. Keep a secret out of the server's environment if the model must not see it.

### Limits of the checks

Path resolution (`realpath`, `lstat`) gives up after 15 seconds with a message naming the path, so a file on a stalled cloud-storage or network drive does not hang the request forever. Reads and writes of the file itself are not time-limited. Windows and WSL path handling is not covered. Do not treat any of this as a sandbox.

## Usage

Requires Node.js 22 or newer.

```bash
npx -y @qsrahman/workshop-mcp [options]
```

npx fetches the [published package](https://www.npmjs.com/package/@qsrahman/workshop-mcp) on first use and caches it. Other ways to run it:

- From GitHub: `npx -y github:qsrahman/workshop-mcp`. A git install builds the package with its `prepare` script, which npm skips if `ignore-scripts` is set in your npm config.
- From source (needs [pnpm](https://pnpm.io)): `pnpm install && pnpm build`, then `node dist/index.js [options]`.
- A local build as a package: `pnpm pack`, then `npx -y --package ./qsrahman-workshop-mcp-*.tgz workshop-mcp`.

### Configuration

workshop-mcp has **no configuration file**. Everything is set by command-line arguments and one environment variable. In an MCP client both go in the server's entry: the arguments in `args`, the variable in `env` (see [Connect a client](#connect-a-client)).

#### Command line

```text
workshop-mcp [options]
```

| Option                    | Default                  | Effect                                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--allow-private-ips`     | private addresses refused | Let `fetch_url` reach loopback, private, link-local and other non-public addresses, such as a local dev server.                                                                                                                                                                                      |
| `--ignore-robots-txt`     | `robots.txt` is obeyed   | Do not consult `robots.txt` before fetching a page.                                                                                                                                                                                                                                                   |
| `--allowed-hosts <hosts>` | any public host          | Limit `fetch_url` to these hosts, for every request including `robots.txt` and redirects. See below.                                                                                                                                                                                                  |
| `-h`, `--help`            |                          | Print the options and exit with status 0. Nothing is served. |
| `-v`, `--version`         |                          | Print the version and exit with status 0. |

**`--allowed-hosts`** takes a comma-separated list, and can be repeated: `--allowed-hosts a.com,*.b.org` and `--allowed-hosts a.com --allowed-hosts '*.b.org'` are the same, and so is the `--allowed-hosts=a.com` form. Each entry is an exact host name or IP address (`docs.example.com`, `192.0.2.7`), or `*.domain`, which matches a subdomain at any depth but not the domain itself (`*.example.com` allows `docs.example.com` and `a.b.example.com`, not `example.com`). No scheme, port, path or other wildcard: `https://a.com` or `a.com:8080` is an error. Empty entries are ignored. Quote `*.domain` in a shell, which would otherwise expand it.

`--help` and `--version` write to stdout, which is otherwise the protocol channel, and are answered before the server starts.

**Mistakes are errors.** An unknown option, such as `--readonly`, or any argument that is not an option makes the server print the usage on stderr and exit with status 1. Flags take no value: `--allow-private-ips=true` is an error. An invalid `--allowed-hosts` entry is an error too.

**Older configurations stop instead of running with more access.** The options `--no-shell`, `--read-only` and `--no-fetch`, and directory arguments, were removed in 0.7.0. A client configuration that still passes one of them makes the server exit with status 1, so remove it; the server cannot honour it.

On startup the server writes one line to stderr saying what it started with, for example `workshop-mcp running on stdio (web search on). File access is not restricted.`

**Tools.** The server always serves `read_file`, `read_multiple_files`, `write_file`, `edit_file`, `shell` and `fetch_url`, and also `web_search` when `BRAVE_API_KEY` is set.

#### Environment variable

| Variable        | Default        | Effect                                                                                                                                                                                                                                                       |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAVE_API_KEY` | unset: no search | A [Brave Search API](https://brave.com/search/api/) key. When set, the server also serves `web_search`. Surrounding whitespace is trimmed, and a blank value counts as unset. It is read only from the environment, never from an option, because a command line shows in process listings. The shell tool does not pass it on to commands. |

#### Examples

On a command line:

```bash
# Defaults: every tool except web search
workshop-mcp

# Fetch pages from a few documentation sites only
workshop-mcp --allowed-hosts docs.python.org,'*.mozilla.org'

# Let the model read your own dev server (and nothing else on the network)
workshop-mcp --allow-private-ips --allowed-hosts localhost

# Add web search
BRAVE_API_KEY=YOUR_KEY workshop-mcp
```

The same in a client's JSON configuration, with the arguments in `args` and the key in `env`:

```json
{
  "mcpServers": {
    "workshop": {
      "command": "npx",
      "args": [
        "-y",
        "@qsrahman/workshop-mcp",
        "--allowed-hosts",
        "docs.python.org,*.mozilla.org"
      ],
      "env": { "BRAVE_API_KEY": "YOUR_KEY" }
    }
  }
}
```

### Connect a client

Every client starts the server as a subprocess over stdio. The server is not restricted to any directory and always serves the shell (see [Security model](#security-model)).

**Claude Code:**

```bash
claude mcp add workshop -- npx -y @qsrahman/workshop-mcp
```

Everything after `--` is the server command, so server options go there too. The default scope is just you in the current project; add `--scope project` before the name to write a shareable `.mcp.json` (Claude Code asks you to approve a project server before using it), or `--scope user` to use it in every project:

```bash
claude mcp add --scope project workshop -- npx -y @qsrahman/workshop-mcp --allowed-hosts docs.python.org
```

**Other clients** take the same entry in their MCP configuration file:

```json
{
  "mcpServers": {
    "workshop": {
      "command": "npx",
      "args": ["-y", "@qsrahman/workshop-mcp"]
    }
  }
}
```

| Client         | Configuration file                                                                                                                                                | Differences                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json` | Settings → Developer → Edit Config opens it. Quit and restart the app completely after saving. |
| Cursor         | `.cursor/mcp.json` (one project) or `~/.cursor/mcp.json` (everywhere)                                                                                             | Add `"type": "stdio"` to the entry.                               |
| VS Code        | `.vscode/mcp.json` in the workspace, or your user profile's `mcp.json`                                                                                            | The top-level key is `servers`, not `mcpServers`, and `"type": "stdio"` is required. |

Claude Desktop writes the server's stderr (including the startup line) to `~/Library/Logs/Claude/mcp-server-workshop.log` on macOS, `%APPDATA%\Claude\logs` on Windows and `~/.config/Claude/logs` on Linux.

To run your own build, replace the command in any config above with `"command": "node", "args": ["/absolute/path/to/workshop-mcp/dist/index.js"]`, or for Claude Code `claude mcp add workshop -- node /absolute/path/to/workshop-mcp/dist/index.js`.

#### Enabling web search

Add the key to the server's environment. For Claude Code, put another option between `--env` and the name:

```bash
claude mcp add --env BRAVE_API_KEY=YOUR_KEY --transport stdio workshop -- npx -y @qsrahman/workshop-mcp
```

For Claude Desktop and Cursor, add an `env` object to the server entry:

```json
"workshop": {
  "command": "npx",
  "args": ["-y", "@qsrahman/workshop-mcp"],
  "env": { "BRAVE_API_KEY": "YOUR_KEY" }
}
```

Keep the key out of anything you commit; `.mcp.json` and Cursor's project `mcp.json` are normally committed.

#### If it does not connect

- Run the same command in a terminal. It prints `workshop-mcp running on stdio. File access is not restricted.` on stderr and then waits for input; press Ctrl-C to stop.
- A configuration written for an older version that still passes `--read-only`, `--no-shell`, `--no-fetch` or a directory makes the server exit with status 1 and print the usage. The client then shows only a failed connection or an empty tool list, without the reason, so the terminal run shows it. Remove the argument.
- An unknown option such as `--readonly` is an error. Check the spelling.
- The server needs Node.js 22 or newer on the `PATH` the client uses; GUI apps do not always see your shell's `PATH`.

## Development

| Command             | Purpose                           |
| ------------------- | --------------------------------- |
| `pnpm build`        | Compile `src/` to `dist/`         |
| `pnpm watch`        | Compile on change                 |
| `pnpm typecheck`    | Type-check `src/` and `tests/`    |
| `pnpm test`         | Run the vitest suite              |
| `pnpm test:coverage` | Run it with coverage, which fails below the floor in `vitest.config.ts` |
| `pnpm format`       | Format with prettier              |
| `pnpm format:check` | Check formatting                  |
| `pnpm validate`     | Build, typecheck, test and format check |

The source layout, conventions and release process are described in [AGENTS.md](AGENTS.md).

## License

MIT (see `LICENSE`). Parts are adapted from [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) (the file tools) and [brave/brave-search-mcp-server](https://github.com/brave/brave-search-mcp-server) (the web search tools), under their own licences; the fetch tool follows the design of the fetch server in the same repository. See `THIRD_PARTY_NOTICES.md`.
