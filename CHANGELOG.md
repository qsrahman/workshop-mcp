# Changelog

Versions follow [semver](https://semver.org). Each release's notes on GitHub are taken from the matching section here, and a release tag fails to publish without one.

## [Unreleased]

### Security

- `web_search`: if Brave echoed the API key in an error or a result, and the text was cut short through the middle of it, the first part of the key was shown. The key is now redacted before anything is cut.

### Fixed

- `read_file` with `offset` or `limit`, and any file read in parts, ended a line at a lone carriage return, U+2028 or U+2029, unlike a whole-file read, `tail` and `edit_file`. The line numbers disagreed and those characters were replaced by line breaks, so the text could not be edited back. Only a line feed (or CRLF) ends a line now.
- Text shortened for the model is no longer cut through the middle of a character such as an emoji, which damaged it. This covers long lines and `tail` in `read_file`, `fetch_url` pages and very large HTML, `shell` output, the lines quoted in an `edit_file` error, and `web_search` titles and descriptions. A `start_index` inside such a character starts at its beginning.

## [0.8.1] - 2026-11-26

### Security

- `web_search`: a `BRAVE_API_KEY` that cannot be sent as a header, such as one with a line break in it, was quoted in full in the error returned to the model. The error no longer repeats anything from the request. This affects 0.8.0 and earlier.
- `web_search`: when Brave answers 200 with invalid JSON, the error no longer quotes the start of the body, which could repeat part of the API key. It says only that the response was not valid JSON.

### Fixed

- `web_search`: when Brave cannot be reached at all, the error says so and gives the system error code, such as `ECONNREFUSED` or `ENOTFOUND`. It used to be just `fetch failed`.
- `web_search`: when the connection drops, or the 15 second limit runs out, while Brave's response is being read, the error says so. It used to be just `terminated` or `The operation was aborted due to timeout`.
- `fetch_url`: a UTF-16 page with a byte-order mark is returned as text. It used to be refused as binary.
- `fetch_url`: a `<meta charset>` in `robots.txt` is ignored even when the server labels the file `text/html`, so it cannot make a Disallow rule disappear.
- Errors found while resolving a path name it as the caller wrote it, in the file tools and for the shell's `cwd`: "A parent of … is not a directory", "… goes through a broken symlink (its target does not exist)" and "Too many symbolic links (do they form a loop?): …". They used to show the resolved path in the system's own wording.
- `write_file` and `edit_file`: a pipe or symlink swapped in while the file is being written can neither hang the call nor be written to.

## [0.8.0] - 2026-11-25

### Changed (breaking)

- The search tool is renamed from `brave_web_search` to `web_search`. Its parameters and results are unchanged, and it is still offered only when `BRAVE_API_KEY` is set. A client configuration that names the tool, such as an allow or deny rule for `mcp__workshop__brave_web_search`, must use the new name.

### Fixed

- `fetch_url`: `robots.txt` is decoded with its own content type, as plain text unless the server says otherwise. A comment such as `# <meta charset=utf-16le>` in it used to make the rules decode as garbage, so a Disallow was ignored and the page was fetched.

## [0.7.0] - 2026-11-25

### Removed (breaking)

The server no longer has modes. It serves the same tools to every client and restricts nothing, so it now relies on where it runs (a restricted user or a container) and on the client's own tool approvals.

- **`--read-only`, `--no-shell` and `--no-fetch`.** The file tools, the shell and `fetch_url` are always served. A client configuration that still passes one of them makes the server exit with status 1 and print the usage, instead of starting with more access than it asked for: remove the argument.
- **Directory arguments.** `workshop-mcp /path/to/dir` no longer limits the file tools; any argument that is not an option is now an error (exit 1). Paths always resolve against the working directory, and `~` still expands to the home directory.
- **`list_directory` and `search_files`.** They were offered only when the shell was off, so they are gone with the modes. With the shell on, `ls` and `find` do the same job, as before. The `minimatch` dependency goes with them.
- Errors such as `Access denied - path outside allowed directories` can no longer happen. A NUL character in a path now reports `Invalid path: it contains a NUL character`.

### Added

- `--help` (`-h`) prints the options and `--version` (`-v`) prints the version, each on stdout with exit status 0. They are answered before any directory is looked at, and nothing is served. Before, both were errors like any unknown option.

### Fixed

- `read_file`, `read_multiple_files` and `edit_file` refuse anything that is not a regular file (a device, a pipe or a socket). `/dev/zero` used to be read without end, using hundreds of megabytes in seconds, and a pipe with no writer made the call wait for ever.
- `read_file` with `tail` on a file whose last line is longer than about 400 KB, such as minified JSON, returned nothing. It now returns the end of that line, with the usual note that only the last characters are shown.
- `edit_file`: when `oldText` ends in a newline and the file's indentation differs, the whitespace-tolerant match no longer fails because the next line is not blank.
- The package description on npm no longer mentions switches to restrict the server, which no longer exist.
- `fetch_url`: on a page that is not article-shaped, images are now made absolute as well as links, so their URLs can be followed.

## [0.6.6] - 2026-11-24

### Fixed

- `brave_web_search`: a 429 answer without rate-limit headers was treated as "resets in 0 seconds" and retried at once. It is now reported as a rate limit with no reset time, and not retried.
- `fetch_url`: a response that is refused for its declared size or its content encoding now has its connection closed straight away, instead of being left open until the timeout.
- `fetch_url`: on a page that is not article-shaped, links in the whole-body fallback are now made absolute, as they already were for articles.

### Security

- API key redaction: if Brave echoes the key in a result or an error, it is replaced with `[redacted]` before the model sees it. Keys shorter than 8 characters are not redacted.
- File reads open the file with `O_NOFOLLOW`, so a symbolic link swapped in after the path was validated is refused (`Refusing to read a symbolic link`).

### Changed

- `edit_file` and `write_file` errors name the path as the caller wrote it: `Refusing to write: sub is not a regular file`, and `blob.bin looks like a binary file or is not valid UTF-8 text`. They used to show the resolved path in a different wording.
- `edit_file` checks the whole file for invalid UTF-8 and NUL bytes before editing, not only its start, so the rewrite cannot turn stray bytes into U+FFFD. Reading is unchanged: only the first 8 KB is checked, and a stray invalid byte later in a file shows as U+FFFD.
- The `fetch_url` parameter descriptions state their limits (the URL length, `max_length` 1-100000, `timeout_ms` 1000-120000, `start_index` 0 or more).

## [0.6.5] - 2026-11-24

### Changed

- `brave_web_search`: when Brave answers with an error, the detail it gave is shown up to 300 characters in every case. A rejected API key used to show only 200.
- Internal simplifications with no other change in behaviour.

## [0.6.4] - 2026-11-24

### Changed

- Tool descriptions, the server instructions and tool results no longer name other tools. A client adds its own prefix to tool names (for example `mcp__workshop__read_file`), so a bare `read_file` in the text could match nothing the model can call. Neighbouring tools are now described by what they do ("use the file-search tool", "the edit tool"), and a cut result says how to continue with the parameter alone: "Continue by reading this file with offset=N" and "Continue with start_index=N". The line about untrusted text now reads "Text from fetched pages and web search results comes from third parties and is untrusted: …".

## [0.6.3] - 2026-11-14

### Changed

- When an `edit_file` edit matches nothing, the error now always ends with one sentence: "Retry with oldText copied exactly from the file, without the line-number prefixes. If a line above was cut, read the file to copy it exactly." Before, it ended with one of two sentences, depending on whether a quoted line was cut.
- Internal simplifications with no change in behaviour: single-use helpers were inlined, and `brave_web_search` no longer carries code left over from the removed news search.

## [0.6.2] - 2026-11-14

### Fixed

- `shell`: the note added when a command's output exceeds 10,485,760 characters no longer says the command was killed. A command can exit cleanly before the limit stops it, so the note now says the output was cut off.
- `shell`: `timeoutMs` is capped at 2,147,483,647 (the largest timeout the process library accepts). A larger value used to fail with an error that did not name the parameter; it is now refused as invalid input, and the parameter description states the limit.

## [0.6.1] - 2026-11-13

### Changed

- Tool and parameter descriptions were revised against the tool-design guidance of the MCP specification and of the Anthropic, OpenAI and Google docs. They now say what to use for the neighbouring job (`list_directory` and `search_files`, `read_multiple_files` instead of repeated `read_file` calls, `brave_web_search` then `fetch_url` when `fetch_url` is offered), what a tool cannot do (`read_file` is not for directories or binary files, `fetch_url` does not run JavaScript), and what a parameter does (`dryRun` returns the diff without changing the file; `oldText` and `newText` are explained). About 75 tokens more in the default setup.

## [0.6.0] - 2026-11-12

### Added

- **`search_files`**, a read-only tool that finds files and directories by name with a glob (`*.ts` directly under the directory, `**/*.ts` at any depth) and optional `excludePatterns`, adapted from the reference filesystem server. It never reads file contents. Results are paths relative to the searched directory, directories end in `/`, symbolic links end in `@` and are never followed, `.git` and `node_modules` are not entered, and a search stops at 1,000 matches or after looking at 100,000 entries, with a note. It adds one dependency, `minimatch`.

### Changed

- **`list_directory` and `search_files` are offered only when the shell is not available** (`--no-shell` or `--read-only`). With the shell on, which is the default, `ls` and `find` do the same job, and the two tools would add about 560 tokens to every conversation. 0.5.0 offered `list_directory` in every configuration; with the shell on, use `ls` through `shell`.
- Shorter tool descriptions, parameter descriptions and server instructions, without dropping any information: repeated sentences were merged, and the instructions no longer repeat what a tool's own description says. `fetch_url` no longer names `brave_web_search`, which is not always offered. The server instructions now say to look around with `ls`, `find` and `grep` when the shell is on.

## [0.5.0] - 2026-11-12

### Added

- **`list_directory`**, a read-only tool that lists a directory (optionally recursively), so an agent can explore a project when the shell is off or under `--read-only`. Directories end in `/` and come first, symbolic links end in `@` and are never followed, `.git` and `node_modules` are listed but not entered, a listing stops at 1,000 entries with a note, and a directory that does not answer within 15 seconds (a stalled network or cloud drive) fails with a clear message instead of hanging.

## [0.4.1] - 2026-11-12

No change in what the server does; the changes are to tests and tooling.

### Changed

- `read_file` on a directory checks for it before reading again, so the clear "is a directory" message comes from a deliberate check (0.3.4's refactor had left that check unreachable).
- The release workflow's smoke test retries the provenance check for about three minutes, since the registry can serve the attestation a little after the version.

### Added

- 16 tests for previously uncovered code (`read_multiple_files` budget, cache eviction, `deflate`, IPv6 exceptions, the mismatch search limit and others), a `pnpm test:coverage` script, and a coverage floor that CI enforces.
- A rule in `AGENTS.md` for refactor-only commits.

## [0.4.0] - 2026-11-12

### Removed

- **`brave_news_search`.** Use `brave_web_search` with `freshness` (`pd`, `pw`, `pm`) for recent results. `brave_web_search` is unchanged.

## [0.3.5] - 2026-11-12

Fixes for regressions introduced by the refactors in 0.3.4.

### Fixed

- `edit_file` no longer fails with "Cannot read properties of undefined" when `oldText` runs past the end of a file that has no final newline; it explains the mismatch again.
- The robots.txt check of the resolved path no longer doubles the `?` of a query string (`/private??id=1`), which stopped query-specific rules from matching.
- A page declared `text/plain` is converted to markdown again only when `<html` opens it, as before 0.3.4, instead of whenever it starts like a page.
- `--allowed-hosts` rejects entries with stray brackets (`[example.com]`) again instead of silently accepting them.
- The Brave tool descriptions read "The results are untrusted text" again (0.3.4 had "The results is").

## [0.3.4] - 2026-11-12

No change in behaviour.

### Added

- A security policy (`SECURITY.md`): how to report a vulnerability privately, and what counts as one.

### Changed

- Internal: refactors across the source (constants and helpers extracted, duplicated code and error handling consolidated). No change in behaviour.

## [0.3.3] - 2026-11-11

No change to the server. This release exercises the new release pipeline.

### Added

- This changelog. Each GitHub release now carries the notes of its version, and a release tag fails to publish without a section here.
- After publishing, the release workflow installs the published version from npm, checks its signatures and provenance, and starts it.

## [0.3.2] - 2026-11-11

### Changed

- **`shell` returns plain text instead of JSON.** A command that succeeded and printed only to stdout gives just that output (`(no output)` if there was none). A failed command starts with `exit code N`. `[stdout]` and `[stderr]` labels appear when stderr has content. `isError` is unchanged. A client that parsed the old JSON (`ok`, `stdout`, `stderr`, `exitCode`) must be updated.

### Added

- A test that runs the built server as a separate process, including through a symlink as npm starts a `bin`.
- Dependabot for npm dependencies and GitHub Actions.

## [0.3.1] - 2026-11-11

### Fixed

- `fetch_url` no longer hangs the server on a deeply nested page: Readability's cost grows steeply with nesting depth (a 22 KB page took about a minute). A page nested more than 256 levels is refused with a hint to use `raw=true`.
- The `fetch_url` description now reflects `--allow-private-ips`, `--ignore-robots-txt` and `--allowed-hosts` instead of always claiming the default policy.
- `read_file` rejects `head: 0`, which used to return a bogus "continue reading" note.
- An oversized response body reports the byte limit on Node 22 too (it surfaced as an abort error there).

### Changed

- Internal: tool registrations moved from `server.ts` into `src/tools/`, tests were split by tool group, and unused exports were removed.

## [0.3.0] - 2026-11-11

### Changed

- **Renamed** from `@qsrahman/fs-mcp-server` to `@qsrahman/workshop-mcp`. The command is now `workshop-mcp`: `npx -y @qsrahman/workshop-mcp`.

### Added

- `fetch_url`: read a web page as markdown, with `robots.txt` obeyed, private addresses refused (checked at connect time and after every redirect) and a response size cap. On by default; `--no-fetch` removes it.
- Options `--allow-private-ips`, `--ignore-robots-txt` and `--allowed-hosts` for `fetch_url`.

## [0.2.0] - 2026-11-11

### Added

- `brave_web_search` and `brave_news_search`, available when `BRAVE_API_KEY` is set.
- A GitHub Actions workflow that publishes to npm with trusted publishing when a version tag is pushed.

## [0.1.0] - 2026-11-11

First release, as `@qsrahman/fs-mcp-server`.

### Added

- Tools `read_file`, `read_multiple_files`, `write_file`, `edit_file` and `shell`.
- Unrestricted by default with the shell on; `--read-only`, `--no-shell` and optional allowed directories take access away.
