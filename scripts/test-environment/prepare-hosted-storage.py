#!/usr/bin/env python3
"""Inspect a new operator-chosen storage tree; only --prepare creates it.

Does not move existing data, edit services, or change Docker's data-root.
"""

import argparse
import json
import os
from pathlib import Path
import stat
import sys


def directory_fd(path):
    """Follow existing real directories only, not symlinked parent components."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open("/", flags)
    try:
        for component in path.parts[1:]:
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def prepare(options):
    root = Path(options.root)
    if not root.is_absolute() or str(root) != options.root or ".." in root.parts or root == Path("/"):
        raise ValueError("use_a_canonical_new_absolute_directory")
    if options.min_free_mib < 1:
        raise ValueError("invalid_free_space_requirement")
    uid = os.geteuid() if options.uid is None else options.uid
    gid = os.getegid() if options.gid is None else options.gid
    if not 0 <= uid <= 2147483647 or not 0 <= gid <= 2147483647:
        raise ValueError("invalid_directory_owner")
    if options.prepare and os.geteuid() != 0 and (uid != os.geteuid() or gid != os.getegid()):
        raise ValueError("directory_owner_requires_operator_privilege")
    parent_fd = directory_fd(root.parent)
    try:
        parent = os.fstat(parent_fd)
        if parent.st_uid not in (0, os.geteuid()) or stat.S_IMODE(parent.st_mode) & 0o022:
            raise ValueError("parent_must_be_operator_owned_and_not_shared_writable")
        try:
            os.stat(root.name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ValueError("existing_data_or_link_will_not_be_overwritten")
        filesystem = os.fstatvfs(parent_fd)
        free_bytes = filesystem.f_bavail * filesystem.f_frsize
        if free_bytes < options.min_free_mib * 1024 * 1024:
            raise ValueError("insufficient_free_space")
        if options.prepare:
            # mkdir is exclusive; no recursive deletion or migration is performed.
            os.mkdir(root.name, mode=0o700, dir_fd=parent_fd)
            root_fd = os.open(root.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            try:
                for child in ("cache", "hosted-tmp"):
                    os.mkdir(child, mode=0o700, dir_fd=root_fd)
                    os.chown(child, uid, gid, dir_fd=root_fd, follow_symlinks=False)
                os.fchown(root_fd, uid, gid)
            finally:
                os.close(root_fd)
        return {"prepared": options.prepare, "root": str(root), "uid": uid, "gid": gid,
                "filesystem_device": parent.st_dev, "free_bytes": free_bytes,
                "candidate": str(root / "candidate"), "image_export": str(root / "hosted-image"),
                "npm_cache": str(root / "cache"), "hosted_tmp": str(root / "hosted-tmp")}
    finally:
        os.close(parent_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", help="A new absolute directory on an operator-verified filesystem")
    parser.add_argument("--prepare", action="store_true", help="Explicitly create only this new private tree")
    parser.add_argument("--min-free-mib", type=int, default=2048)
    parser.add_argument("--uid", type=int, help="Owner of newly created directories only")
    parser.add_argument("--gid", type=int, help="Group of newly created directories only")
    options = parser.parse_args()
    try:
        print(json.dumps(prepare(options), separators=(",", ":")))
    except ValueError as error:
        print(f"Hosted storage preparation refused: {error}", file=sys.stderr)
        return 1
    except OSError:
        # No filesystem contents or raw exception reach operator/public logs.
        print("Hosted storage preparation refused: directory_unavailable_or_changed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
