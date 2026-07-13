#!/usr/bin/env python3
"""Descriptor-relative filesystem operations for parsed cleanup.

Node.js does not expose renameat/unlinkat/fstatat. The parent passes the already
validated quarantine directory as child fd 3 so mutations cannot be redirected
by replacing the directory pathname between validation and the syscall.
"""

from __future__ import annotations

import json
import ctypes
import errno
import os
import stat
import sys
from datetime import datetime, timezone
from typing import Optional


def require_name(value: str) -> str:
    if (
        value in {"", ".", ".."}
        or os.sep in value
        or (os.altsep and os.altsep in value)
    ):
        raise ValueError("quarantine name must be one path segment")
    return value


def require_integer(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def require_string(value: object, label: str) -> str:
    if not isinstance(value, str) or value == "":
        raise ValueError(f"{label} must be a non-empty string")
    return value


def rename_no_replace(source_fd: int, source_name: str, destination_name: str) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    source = os.fsencode(source_name)
    destination = os.fsencode(destination_name)
    if sys.platform == "darwin":
        rename = libc.renameatx_np
        rename.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        rename.restype = ctypes.c_int
        result = rename(source_fd, source, 3, destination, 0x00000004)  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        try:
            rename = libc.renameat2
        except AttributeError as error:
            raise OSError(errno.ENOTSUP, "renameat2 is unavailable") from error
        rename.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        rename.restype = ctypes.c_int
        result = rename(
            source_fd, source, 3, destination, 0x00000001
        )  # RENAME_NOREPLACE
    else:
        raise OSError(errno.ENOTSUP, "no supported no-replace rename primitive")
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), destination_name)


def open_validated_source(extra: object) -> tuple[int, str]:
    if not isinstance(extra, dict):
        raise ValueError("rename-into requires source metadata")
    source_directory = require_string(extra.get("source_directory"), "source directory")
    source_name = require_name(require_string(extra.get("source_name"), "source name"))
    source_fd = os.open(
        source_directory,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        directory_metadata = os.fstat(source_fd)
        if not stat.S_ISDIR(directory_metadata.st_mode):
            raise OSError(errno.ENOTDIR, "source parent is not a directory")
        if directory_metadata.st_dev != require_integer(
            extra.get("source_directory_device"), "source directory device"
        ) or directory_metadata.st_ino != require_integer(
            extra.get("source_directory_inode"), "source directory inode"
        ):
            raise OSError(errno.ESTALE, "source parent identity changed")

        source_metadata = os.stat(source_name, dir_fd=source_fd, follow_symlinks=False)
        if not stat.S_ISREG(source_metadata.st_mode):
            raise OSError(errno.EINVAL, "source is not a regular file")
        expected = (
            require_integer(extra.get("source_device"), "source device"),
            require_integer(extra.get("source_inode"), "source inode"),
            require_integer(extra.get("source_size"), "source size"),
        )
        if (
            source_metadata.st_dev,
            source_metadata.st_ino,
            source_metadata.st_size,
        ) != expected:
            raise OSError(errno.ESTALE, "source file identity changed")
        expected_mtime_ns = extra.get("source_modified_at_nanoseconds")
        if expected_mtime_ns is not None:
            if (
                not isinstance(expected_mtime_ns, str)
                or not expected_mtime_ns.isdecimal()
            ):
                raise ValueError("source mtime nanoseconds must be a decimal string")
            if source_metadata.st_mtime_ns != int(expected_mtime_ns):
                raise OSError(errno.ESTALE, "source file timestamp changed")
        return source_fd, source_name
    except Exception:
        os.close(source_fd)
        raise


def metadata(name: str) -> dict[str, object]:
    value = os.stat(name, dir_fd=3, follow_symlinks=False)
    seconds, milliseconds = divmod(value.st_mtime_ns // 1_000_000, 1_000)
    modified_at = (
        datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        + f".{milliseconds:03d}Z"
    )
    return {
        "device": value.st_dev,
        "inode": value.st_ino,
        "is_file": stat.S_ISREG(value.st_mode),
        "is_symbolic_link": stat.S_ISLNK(value.st_mode),
        "modified_at": modified_at,
        "modified_at_nanoseconds": str(value.st_mtime_ns),
        "size": value.st_size,
    }


def execute(
    operation: str, name_value: str, extra: Optional[object] = None
) -> Optional[dict[str, object]]:
    name = require_name(name_value)
    if operation == "rename-into":
        try:
            source_fd, source_name = open_validated_source(extra)
        except OSError as error:
            source_path = (
                os.path.join(
                    str(extra.get("source_directory", "")),
                    str(extra.get("source_name", "")),
                )
                if isinstance(extra, dict)
                else ""
            )
            raise OSError(
                error.errno,
                f"unsafe parsed cleanup path: {source_path}",
                error.filename,
            ) from error
        try:
            rename_no_replace(source_fd, source_name, name)
            os.fsync(source_fd)
            os.fsync(3)
        finally:
            os.close(source_fd)
        return None
    if operation == "unlink":
        os.unlink(name, dir_fd=3)
        os.fsync(3)
        return None
    if operation == "stat":
        return metadata(name)
    raise ValueError(f"unknown operation: {operation}")


def error_payload(error: Exception) -> dict[str, object]:
    return {
        "code": errno.errorcode.get(error.errno, "EIO")
        if isinstance(error, OSError)
        else "EINVAL",
        "message": str(error),
    }


def serve() -> None:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = execute(
                request["operation"], request["name"], request.get("extra")
            )
            response = {"ok": True, "result": result}
        except (
            OSError,
            ValueError,
            KeyError,
            TypeError,
            json.JSONDecodeError,
        ) as error:
            response = {"error": error_payload(error), "ok": False}
        print(json.dumps(response, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "serve":
        serve()
    else:
        try:
            extra = (
                json.loads(sys.argv[3])
                if len(sys.argv) > 3 and sys.argv[1] == "rename-into"
                else (sys.argv[3] if len(sys.argv) > 3 else None)
            )
            value = execute(sys.argv[1], sys.argv[2], extra)
            if value is not None:
                print(json.dumps(value, separators=(",", ":")))
        except (OSError, ValueError) as error:
            print(
                json.dumps(error_payload(error), separators=(",", ":")), file=sys.stderr
            )
            raise SystemExit(1) from error
