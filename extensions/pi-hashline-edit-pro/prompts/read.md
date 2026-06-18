Read a text file. Each line is returned as `HASH│content`.

HASH format:
- The HASH is 4 characters from the URL-safe base64 alphabet `A-Za-z0-9-_` (e.g. `aB3x`, `4yN-`, `-qkl`).
- The content after the `│` separator is the line verbatim.
- The line number is not part of the output. Use the HASH to reference lines.

Pagination:
- Large files return a truncated preview with a `nextOffset` line. Call `read` again with `offset=nextOffset` to continue.

File kinds:
- Text files are returned as `HASH│content` lines.
- Images (JPEG, PNG, GIF, WebP) are returned as visual attachments.
- Binary files and directories are rejected with a descriptive error.

Non-UTF-8 bytes:
- Non-UTF-8 bytes are decoded as U+FFFD. The output is flagged when this happens.