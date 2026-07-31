# Security model

Paths are relative, normalized, and reject traversal, absolute paths, drive
prefixes, and NUL bytes. Folder walks have depth, file-count, and total-byte
limits. Read permission is requested only for a user-selected directory.

The package never persists handles. Applications may add persistence through a
separate, explicit integration after applying their own permission and privacy
policy.
