#!/usr/bin/env python3
"""Split an existing verified data archive; never downloads or changes source data."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

PART_SIZE = 64 * 1024 * 1024
READ_SIZE = 1024 * 1024


def _digest_file(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(READ_SIZE), b""):
            digest.update(block)
            size += len(block)
    return size, digest.hexdigest()


def split_archive(archive, output_dir, *, part_size=PART_SIZE,
                  expected_size=None, expected_sha256=None):
    """Write a new directory atomically after checking source and recombined bytes.

    part_size is configurable for local fixture tests; production uses 64 MiB.
    Existing output directories (including empty ones or symlinks) are refused.
    """
    archive = Path(archive).resolve(strict=True)
    if not archive.is_file():
        raise ValueError("Archive must be a regular file")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", archive.name):
        raise ValueError("Archive basename must be a portable filename")
    before = archive.stat()
    if before.st_size < 1:
        raise ValueError("Archive is empty")
    if isinstance(part_size, bool) or not isinstance(part_size, int) or part_size < 1:
        raise ValueError("part_size must be a positive integer")
    if (before.st_size + part_size - 1) // part_size > 999:
        raise ValueError("More than 999 parts would be required")
    if expected_size is not None and before.st_size != expected_size:
        raise ValueError("Source archive size does not match expected_size")
    if expected_sha256 is not None and not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
        raise ValueError("expected_sha256 must be a lowercase SHA256 digest")

    requested_output = Path(output_dir).absolute()
    if os.path.lexists(requested_output):
        raise FileExistsError(f"Refusing to overwrite existing output: {requested_output}")
    # The caller chooses the output's parent. Only our own new child is written.
    requested_output.parent.mkdir(parents=True, exist_ok=True)
    output = requested_output.parent.resolve(strict=True) / requested_output.name
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        parts = []
        source_hash = hashlib.sha256()
        total = 0
        with archive.open("rb") as source:
            index = 1
            while total < before.st_size:
                name = f"{archive.name}.part-{index:03d}"
                digest = hashlib.sha256()
                size = 0
                with (staging / name).open("xb") as target:
                    while size < part_size:
                        block = source.read(min(READ_SIZE, part_size - size))
                        if not block:
                            break
                        target.write(block)
                        digest.update(block)
                        source_hash.update(block)
                        size += len(block)
                        total += len(block)
                    target.flush()
                    os.fsync(target.fileno())
                if size < 1:
                    raise ValueError("Source changed or ended before its declared size")
                parts.append({"name": name, "size": size, "sha256": digest.hexdigest()})
                index += 1
            if source.read(1):
                raise ValueError("Source archive grew during splitting")
        after = archive.stat()
        if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) !=
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
            raise ValueError("Source archive changed during splitting")
        if total != before.st_size:
            raise ValueError("Source byte count mismatch")
        archive_sha256 = source_hash.hexdigest()
        if expected_sha256 is not None and archive_sha256 != expected_sha256:
            raise ValueError("Source archive SHA256 does not match expected_sha256")

        # Reopen every written part, checking its own hash and the concatenation.
        # This verifies reconstruction without creating another full-size copy.
        recombined = hashlib.sha256()
        recombined_size = 0
        for part in parts:
            part_hash = hashlib.sha256()
            part_size_seen = 0
            with (staging / part["name"]).open("rb") as handle:
                for block in iter(lambda: handle.read(READ_SIZE), b""):
                    part_hash.update(block)
                    recombined.update(block)
                    part_size_seen += len(block)
                    recombined_size += len(block)
            if part_size_seen != part["size"] or part_hash.hexdigest() != part["sha256"]:
                raise ValueError(f"Written part verification failed: {part['name']}")
        if recombined_size != total or recombined.hexdigest() != archive_sha256:
            raise ValueError("Recombined archive differs from source")
        manifest = {
            "schemaVersion": 1,
            "archive": {"name": archive.name, "size": total, "sha256": archive_sha256},
            "partSize": part_size,
            "parts": parts,
        }
        (staging / "PARTS.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (staging / "PARTS.SHA256SUMS").write_text(
            "".join(f"{part['sha256']}  {part['name']}\n" for part in parts), encoding="utf-8")
        if os.path.lexists(output):
            raise FileExistsError(f"Output appeared during splitting: {output}")
        staging.rename(output)
        return manifest
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", help="Existing local archive, never modified")
    parser.add_argument("--output-dir", help="New directory; default: ARCHIVE.parts")
    parser.add_argument("--expected-size", type=int, help="Required source size in bytes")
    parser.add_argument("--expected-sha256", help="Required source SHA256")
    args = parser.parse_args(argv)
    output = args.output_dir or (args.archive + ".parts")
    try:
        manifest = split_archive(args.archive, output,
                                 expected_size=args.expected_size,
                                 expected_sha256=args.expected_sha256)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Split failed: {error}\n")
    print(json.dumps({"outputDir": str(Path(output).resolve()),
                      "parts": len(manifest["parts"]), "archive": manifest["archive"]}))


if __name__ == "__main__":
    main()
