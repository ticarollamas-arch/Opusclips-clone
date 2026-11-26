"""Chunked video upload straight onto the local uploads volume.

Why it exists: a proxy in front of the API (the free Cloudflare tunnel, for
one) refuses request bodies above 100 MB, and the browser then reports a bare
"Failed to fetch". Sending the video in small parts keeps every request far
below that limit, and a dropped connection only costs the part in flight.

How it works:

* ``begin`` creates a session and a sparse file of the final size.
* ``open_part`` returns a writer that stores one part at its own offset in
  that file, so there is no reassembly pass and no second copy on disk.
* ``publish`` checks that every part arrived, hashes the file, fsyncs it and
  links it to its final name.
* ``mark_completed`` keeps a tiny record of the result, so a client that
  lost the response to ``complete`` can ask again and get the same answer.

Everything here is synchronous and uses only the standard library. The routes
call it through ``run_in_thread``, and the tests need neither FastAPI nor a
database.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
import re
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Iterator

from .upload_limits import upload_too_large_detail

DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024
# A larger cap than the default would otherwise mean thousands of parts.
MAX_PARTS = 4096
ONE_MIB = 1024 * 1024
HASH_BLOCK_BYTES = 4 * ONE_MIB
FREE_SPACE_MARGIN_BYTES = 1024 * ONE_MIB
DEFAULT_STALE_SECONDS = 6 * 3600
DEFAULT_MAX_ACTIVE_PER_USER = 3

_UPLOAD_ID = re.compile(r"[0-9a-f]{32}")
_PART_MARKER = re.compile(r"part-(\d{6})\.ok")


class ChunkedUploadError(Exception):
    """A failure the client can act on, with the HTTP status to answer with."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class ChunkedSession:
    upload_id: str
    user_id: str
    extension: str
    size: int
    chunk_size: int
    total_parts: int
    created_at: float


def plan_chunks(size: int, chunk_bytes: int = DEFAULT_CHUNK_BYTES) -> tuple[int, int]:
    """Return ``(chunk_size, total_parts)`` for a file of ``size`` bytes."""
    chunk = chunk_bytes
    if math.ceil(size / chunk) > MAX_PARTS:
        chunk = math.ceil(size / MAX_PARTS / ONE_MIB) * ONE_MIB
    return chunk, math.ceil(size / chunk)


def _fsync_path(path: Path) -> None:
    with path.open("rb+") as handle:
        handle.flush()
        os.fsync(handle.fileno())


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_json_atomically(path: Path, payload: dict) -> None:
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload))
    os.replace(temporary, path)


class PartWriter:
    """Writes one part at its offset. ``commit`` is what marks the part as received."""

    def __init__(self, descriptor: int, offset: int, expected: int, marker: Path):
        self._descriptor = descriptor
        self._offset = offset
        self._marker = marker
        self._lock = threading.Lock()
        self._closed = False
        self.expected = expected
        self.written = 0

    def write(self, chunk: bytes) -> None:
        with self._lock:
            if self._closed:
                raise ChunkedUploadError(409, "This part is no longer being written.")
            if self.written + len(chunk) > self.expected:
                raise ChunkedUploadError(413, "The part is larger than expected.")
            view = memoryview(chunk)
            position = 0
            while position < len(view):
                position += os.pwrite(
                    self._descriptor, view[position:], self._offset + self.written + position
                )
            self.written += len(chunk)

    def commit(self) -> None:
        with self._lock:
            if self._closed:
                raise ChunkedUploadError(409, "This part is no longer being written.")
            if self.written != self.expected:
                raise ChunkedUploadError(
                    400, f"Incomplete part: received {self.written} of {self.expected} bytes."
                )
            os.close(self._descriptor)
            self._closed = True
            self._marker.touch()

    def abort(self) -> None:
        # Taking the lock waits for a write that a worker thread still has in
        # flight, so the descriptor is never closed underneath it.
        with self._lock:
            if not self._closed:
                os.close(self._descriptor)
                self._closed = True


class ChunkedUploadStore:
    def __init__(
        self,
        root: Path,
        *,
        max_bytes: int,
        chunk_bytes: int = DEFAULT_CHUNK_BYTES,
        max_active_per_user: int = DEFAULT_MAX_ACTIVE_PER_USER,
        stale_after_seconds: int = DEFAULT_STALE_SECONDS,
        min_free_bytes: int = FREE_SPACE_MARGIN_BYTES,
    ):
        self.root = Path(root)
        self.max_bytes = max_bytes
        self.chunk_bytes = chunk_bytes
        self.max_active_per_user = max_active_per_user
        self.stale_after_seconds = stale_after_seconds
        self.min_free_bytes = min_free_bytes

    # -- layout ---------------------------------------------------------

    def _directory(self, upload_id: str) -> Path:
        return self.root / upload_id

    def _data(self, upload_id: str) -> Path:
        return self._directory(upload_id) / "data"

    def _marker(self, upload_id: str, index: int) -> Path:
        return self._directory(upload_id) / f"part-{index:06d}.ok"

    def _directories(self) -> Iterator[Path]:
        try:
            entries = list(self.root.iterdir())
        except FileNotFoundError:
            return
        for entry in entries:
            if entry.is_dir() and _UPLOAD_ID.fullmatch(entry.name):
                yield entry

    def _read_session(self, directory: Path) -> ChunkedSession | None:
        try:
            meta = json.loads((directory / "meta.json").read_text())
            return ChunkedSession(
                upload_id=directory.name,
                user_id=meta["user_id"],
                extension=meta["extension"],
                size=meta["size"],
                chunk_size=meta["chunk_size"],
                total_parts=meta["total_parts"],
                created_at=meta["created_at"],
            )
        except (OSError, ValueError, KeyError, TypeError):
            return None

    # -- lifecycle ------------------------------------------------------

    def begin(self, user_id: str, extension: str, size: object) -> ChunkedSession:
        if type(size) is not int or size <= 0:
            raise ChunkedUploadError(400, "A file size is required.")
        if size > self.max_bytes:
            raise ChunkedUploadError(413, upload_too_large_detail(self.max_bytes))
        self.root.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(self.root).free < size + self.min_free_bytes:
            raise ChunkedUploadError(507, "The server does not have enough free space for this video.")

        self.sweep_stale()
        self._evict_oldest(user_id)

        chunk_size, total_parts = plan_chunks(size, self.chunk_bytes)
        upload_id = os.urandom(16).hex()
        directory = self._directory(upload_id)
        directory.mkdir()
        try:
            descriptor = os.open(self._data(upload_id), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.ftruncate(descriptor, size)
            finally:
                os.close(descriptor)
            created_at = time.time()
            _write_json_atomically(
                directory / "meta.json",
                {
                    "user_id": user_id,
                    "extension": extension,
                    "size": size,
                    "chunk_size": chunk_size,
                    "total_parts": total_parts,
                    "created_at": created_at,
                },
            )
        except BaseException:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        return ChunkedSession(upload_id, user_id, extension, size, chunk_size, total_parts, created_at)

    def load(self, upload_id: str, user_id: str) -> ChunkedSession:
        """The session for ``upload_id``. Another user's session looks like a missing one."""
        if not isinstance(upload_id, str) or not _UPLOAD_ID.fullmatch(upload_id):
            raise ChunkedUploadError(404, "Upload not found or expired.")
        session = self._read_session(self._directory(upload_id))
        if session is None or session.user_id != user_id:
            raise ChunkedUploadError(404, "Upload not found or expired.")
        return session

    def expected_part_size(self, session: ChunkedSession, index: int) -> int:
        if type(index) is not int or not 0 <= index < session.total_parts:
            raise ChunkedUploadError(400, "Invalid part number.")
        return min(session.chunk_size, session.size - index * session.chunk_size)

    def open_part(self, session: ChunkedSession, index: int) -> PartWriter:
        expected = self.expected_part_size(session, index)
        if self.completed_result(session) is not None:
            raise ChunkedUploadError(409, "This upload is already complete.")
        # Re-sending a part rewrites its bytes, so it only counts again once it is whole.
        self._marker(session.upload_id, index).unlink(missing_ok=True)
        try:
            descriptor = os.open(self._data(session.upload_id), os.O_WRONLY)
        except FileNotFoundError:
            raise ChunkedUploadError(404, "Upload not found or expired.") from None
        return PartWriter(
            descriptor, index * session.chunk_size, expected, self._marker(session.upload_id, index)
        )

    def received_parts(self, session: ChunkedSession) -> list[int]:
        try:
            names = os.listdir(self._directory(session.upload_id))
        except FileNotFoundError:
            return []
        found = []
        for name in names:
            match = _PART_MARKER.fullmatch(name)
            if match and int(match.group(1)) < session.total_parts:
                found.append(int(match.group(1)))
        return sorted(found)

    def missing_parts(self, session: ChunkedSession) -> list[int]:
        received = set(self.received_parts(session))
        return [index for index in range(session.total_parts) if index not in received]

    # -- completion -----------------------------------------------------

    def acquire_lock(self, session: ChunkedSession) -> IO[str]:
        """Serialise ``complete`` calls for one session. Blocks until the lock is free."""
        try:
            handle = (self._directory(session.upload_id) / "lock").open("a")
        except FileNotFoundError:
            raise ChunkedUploadError(404, "Upload not found or expired.") from None
        fcntl.flock(handle, fcntl.LOCK_EX)
        return handle

    @staticmethod
    def release_lock(handle: IO[str]) -> None:
        try:
            fcntl.flock(handle, fcntl.LOCK_UN)
        finally:
            handle.close()

    def completed_result(self, session: ChunkedSession) -> str | None:
        try:
            result = json.loads((self._directory(session.upload_id) / "completed.json").read_text())
            video_path = result["video_path"]
        except (OSError, ValueError, KeyError, TypeError):
            return None
        return video_path if isinstance(video_path, str) else None

    def publish(self, session: ChunkedSession, destination: Path) -> tuple[str, int]:
        """Verify, hash and fsync the received file, then link it to ``destination``.

        The session keeps its own copy until ``mark_completed``, so a failure
        after this point can be retried without sending the video again.
        """
        missing = self.missing_parts(session)
        if missing:
            raise ChunkedUploadError(409, f"{len(missing)} part(s) of the video are missing.")
        data = self._data(session.upload_id)
        try:
            actual = data.stat().st_size
        except FileNotFoundError:
            raise ChunkedUploadError(404, "Upload not found or expired.") from None
        if actual != session.size:
            raise ChunkedUploadError(409, "The received file does not have the declared size.")

        hasher = hashlib.sha256()
        buffer = bytearray(HASH_BLOCK_BYTES)
        view = memoryview(buffer)
        with data.open("rb") as handle:
            while True:
                count = handle.readinto(buffer)
                if not count:
                    break
                hasher.update(view[:count])
        _fsync_path(data)

        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(data, destination)
        except OSError:
            # No hard links on this filesystem: move instead (a failed claim
            # then needs a fresh upload).
            shutil.move(str(data), str(destination))
        _fsync_directory(destination.parent)
        return hasher.hexdigest(), session.size

    def mark_completed(self, session: ChunkedSession, video_path: str) -> None:
        directory = self._directory(session.upload_id)
        _write_json_atomically(directory / "completed.json", {"video_path": video_path})
        self._data(session.upload_id).unlink(missing_ok=True)
        for index in self.received_parts(session):
            self._marker(session.upload_id, index).unlink(missing_ok=True)

    def discard(self, upload_id: str) -> None:
        if isinstance(upload_id, str) and _UPLOAD_ID.fullmatch(upload_id):
            shutil.rmtree(self._directory(upload_id), ignore_errors=True)

    # -- housekeeping ---------------------------------------------------

    def sweep_stale(self) -> int:
        """Remove sessions nobody has written to for a while. Returns how many."""
        cutoff = time.time() - self.stale_after_seconds
        removed = 0
        for directory in self._directories():
            try:
                if directory.stat().st_mtime < cutoff:
                    shutil.rmtree(directory, ignore_errors=True)
                    removed += 1
            except FileNotFoundError:
                continue
        return removed

    def _evict_oldest(self, user_id: str) -> None:
        """Keep a user's unfinished sessions below the limit, dropping the oldest.

        A retry after a failed attempt starts a new session; refusing it would
        leave the user locked out until the abandoned ones expire.
        """
        active = []
        for directory in self._directories():
            session = self._read_session(directory)
            if session and session.user_id == user_id and not (directory / "completed.json").exists():
                active.append(session)
        active.sort(key=lambda item: (item.created_at, item.upload_id))
        while len(active) >= self.max_active_per_user:
            self.discard(active.pop(0).upload_id)
