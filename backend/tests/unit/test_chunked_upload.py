"""Chunked uploads: each part lands at its own offset and the whole file is verified."""

import hashlib
import os
import threading
import time

import pytest

from src.media.chunked_upload import (
    DEFAULT_CHUNK_BYTES,
    MAX_PARTS,
    ChunkedUploadError,
    ChunkedUploadStore,
    plan_chunks,
)

CHUNK = 1024  # tiny parts keep the tests fast


def make_store(tmp_path, **overrides):
    options = dict(max_bytes=10_000_000, chunk_bytes=CHUNK, min_free_bytes=0)
    options.update(overrides)
    return ChunkedUploadStore(tmp_path / ".chunks", **options)


def payload(size):
    # Not periodic in the part size, so a part written at the wrong offset changes the hash.
    return bytes((index * 31 + index // 7) % 251 for index in range(size))


def send(store, session, data, index, step=300):
    start = index * session.chunk_size
    part = data[start:start + session.chunk_size]
    writer = store.open_part(session, index)
    try:
        for offset in range(0, len(part), step):
            writer.write(part[offset:offset + step])
        writer.commit()
    except BaseException:
        writer.abort()
        raise


def error_status(call):
    with pytest.raises(ChunkedUploadError) as raised:
        call()
    return raised.value.status_code


def test_plan_chunks_defaults_and_scaling():
    assert plan_chunks(1) == (DEFAULT_CHUNK_BYTES, 1)
    assert plan_chunks(4_000_000_000) == (DEFAULT_CHUNK_BYTES, 477)
    # A cap raised far above the default must not mean thousands of tiny parts.
    chunk, parts = plan_chunks(50_000_000_000)
    assert parts <= MAX_PARTS and chunk % (1024 * 1024) == 0 and chunk * parts >= 50_000_000_000


def test_parts_in_any_order_rebuild_the_exact_file(tmp_path):
    store = make_store(tmp_path)
    data = payload(5 * CHUNK + 100)
    session = store.begin("user-1", ".mp4", len(data))
    assert (session.chunk_size, session.total_parts) == (CHUNK, 6)

    for index in (3, 0, 5, 1, 4):
        send(store, session, data, index)
    assert store.missing_parts(session) == [2]
    send(store, session, data, 2)
    assert store.missing_parts(session) == []

    destination = tmp_path / "uploads" / "final.mp4"
    digest, size = store.publish(session, destination)
    assert size == len(data)
    assert digest == hashlib.sha256(data).hexdigest()
    assert destination.read_bytes() == data


def test_publish_keeps_the_session_copy_until_completed(tmp_path):
    store = make_store(tmp_path)
    data = payload(2 * CHUNK)
    session = store.begin("user-1", ".mp4", len(data))
    for index in range(2):
        send(store, session, data, index)

    destination = tmp_path / "uploads" / "final.mp4"
    store.publish(session, destination)
    assert (store.root / session.upload_id / "data").exists()  # a failed claim can retry
    assert store.completed_result(session) is None

    store.mark_completed(session, "upload://final.mp4")
    assert not (store.root / session.upload_id / "data").exists()
    assert store.received_parts(session) == []
    assert destination.read_bytes() == data  # the published link survives
    # A client that lost the response asks again and gets the same answer.
    assert store.completed_result(store.load(session.upload_id, "user-1")) == "upload://final.mp4"
    assert error_status(lambda: store.open_part(session, 0)) == 409


def test_resent_part_only_counts_once_it_is_whole(tmp_path):
    store = make_store(tmp_path)
    data = payload(3 * CHUNK)
    session = store.begin("user-1", ".mp4", len(data))
    for index in range(3):
        send(store, session, data, index)

    writer = store.open_part(session, 1)  # a retry starts over
    writer.write(b"\xff" * 100)
    writer.abort()
    assert store.missing_parts(session) == [1]
    assert error_status(lambda: store.publish(session, tmp_path / "x.mp4")) == 409

    send(store, session, data, 1)
    digest, _ = store.publish(session, tmp_path / "y.mp4")
    assert digest == hashlib.sha256(data).hexdigest()


def test_part_sizes_are_enforced(tmp_path):
    store = make_store(tmp_path)
    data = payload(CHUNK + 10)
    session = store.begin("user-1", ".mp4", len(data))

    too_long = store.open_part(session, 1)  # the last part holds only 10 bytes
    assert error_status(lambda: too_long.write(b"x" * 11)) == 413
    too_long.abort()

    short = store.open_part(session, 0)
    short.write(b"x" * (CHUNK - 1))
    assert error_status(short.commit) == 400
    short.abort()
    assert store.received_parts(session) == []


def test_aborted_writer_cannot_write_again(tmp_path):
    store = make_store(tmp_path)
    session = store.begin("user-1", ".mp4", CHUNK)
    writer = store.open_part(session, 0)
    writer.abort()
    writer.abort()  # closing twice is harmless
    assert error_status(lambda: writer.write(b"x")) == 409
    assert error_status(writer.commit) == 409


@pytest.mark.parametrize("index", [-1, 6, 10**9, "1", 1.5, None, True])
def test_part_index_must_exist(tmp_path, index):
    store = make_store(tmp_path)
    session = store.begin("user-1", ".mp4", 5 * CHUNK + 1)
    assert error_status(lambda: store.open_part(session, index)) == 400


def test_other_users_and_forged_ids_are_not_found(tmp_path):
    store = make_store(tmp_path)
    session = store.begin("user-1", ".mp4", CHUNK)
    assert store.load(session.upload_id, "user-1") == session
    assert error_status(lambda: store.load(session.upload_id, "user-2")) == 404
    for forged in ("../escape", "..", "", "A" * 32, "0" * 31, "g" * 32, None, 12):
        assert error_status(lambda forged=forged: store.load(forged, "user-1")) == 404


@pytest.mark.parametrize("size", [0, -5, True, False, "10", 1.5, None])
def test_begin_rejects_unusable_sizes(tmp_path, size):
    assert error_status(lambda: make_store(tmp_path).begin("user-1", ".mp4", size)) == 400


def test_begin_enforces_the_size_cap_and_free_space(tmp_path):
    store = make_store(tmp_path, max_bytes=1000)
    assert error_status(lambda: store.begin("user-1", ".mp4", 1001)) == 413
    assert store.begin("user-1", ".mp4", 1000).size == 1000
    starved = make_store(tmp_path, min_free_bytes=10**18)
    assert error_status(lambda: starved.begin("user-1", ".mp4", 10)) == 507


def test_publish_needs_every_part(tmp_path):
    store = make_store(tmp_path)
    data = payload(3 * CHUNK)
    session = store.begin("user-1", ".mp4", len(data))
    send(store, session, data, 0)
    assert error_status(lambda: store.publish(session, tmp_path / "x.mp4")) == 409
    assert not (tmp_path / "x.mp4").exists()


def test_parts_may_arrive_concurrently(tmp_path):
    store = make_store(tmp_path)
    data = payload(16 * CHUNK + 5)
    session = store.begin("user-1", ".mp4", len(data))
    errors = []

    def worker(indices):
        try:
            for index in indices:
                send(store, session, data, index, step=97)
        except BaseException as exc:  # pragma: no cover - reported below
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(range(n, 17, 4),)) for n in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors
    digest, _ = store.publish(session, tmp_path / "final.mp4")
    assert digest == hashlib.sha256(data).hexdigest()


def test_abandoned_sessions_expire(tmp_path):
    store = make_store(tmp_path, stale_after_seconds=3600)
    old = store.begin("user-1", ".mp4", CHUNK)
    fresh = store.begin("user-2", ".mp4", CHUNK)
    long_ago = time.time() - 7200
    os.utime(store.root / old.upload_id, (long_ago, long_ago))

    assert store.sweep_stale() == 1
    assert error_status(lambda: store.load(old.upload_id, "user-1")) == 404
    assert store.load(fresh.upload_id, "user-2") == fresh


def test_user_limit_drops_the_oldest_unfinished_session(tmp_path):
    store = make_store(tmp_path, max_active_per_user=2)
    other = store.begin("user-2", ".mp4", CHUNK)
    first = store.begin("user-1", ".mp4", CHUNK)
    second = store.begin("user-1", ".mp4", CHUNK)
    third = store.begin("user-1", ".mp4", CHUNK)  # a retry must never be locked out

    assert error_status(lambda: store.load(first.upload_id, "user-1")) == 404
    assert store.load(second.upload_id, "user-1") == second
    assert store.load(third.upload_id, "user-1") == third
    assert store.load(other.upload_id, "user-2") == other


def test_finished_sessions_do_not_count_against_the_limit(tmp_path):
    store = make_store(tmp_path, max_active_per_user=1)
    data = payload(CHUNK)
    done = store.begin("user-1", ".mp4", len(data))
    send(store, done, data, 0)
    store.publish(done, tmp_path / "final.mp4")
    store.mark_completed(done, "upload://final.mp4")

    store.begin("user-1", ".mp4", CHUNK)
    assert store.completed_result(store.load(done.upload_id, "user-1")) == "upload://final.mp4"


def test_discard_removes_the_session_and_ignores_bad_ids(tmp_path):
    store = make_store(tmp_path)
    session = store.begin("user-1", ".mp4", CHUNK)
    store.discard(session.upload_id)
    assert error_status(lambda: store.load(session.upload_id, "user-1")) == 404
    store.discard("../..")  # never touches anything outside the root
    assert (tmp_path / ".chunks").is_dir()


def test_lock_makes_a_second_complete_wait(tmp_path):
    store = make_store(tmp_path)
    session = store.begin("user-1", ".mp4", CHUNK)
    first = store.acquire_lock(session)
    acquired = threading.Event()

    def second_call():
        handle = store.acquire_lock(session)
        acquired.set()
        store.release_lock(handle)

    thread = threading.Thread(target=second_call)
    thread.start()
    assert not acquired.wait(0.3)
    store.release_lock(first)
    assert acquired.wait(5)
    thread.join()
