from pathlib import Path

from src.media.face_detection import YuNetFaceDetector, open_yunet_detector
from src.video_utils import get_available_transitions

ROOT = Path(__file__).resolve().parents[2]


def test_bundled_transitions_are_real_mp4_files():
    files = list((ROOT / "transitions").glob("*.mp4"))
    assert files
    for f in files:
        assert f.read_bytes()[4:8] == b"ftyp", f.name


def test_get_available_transitions_skips_non_mp4(tmp_path, monkeypatch):
    import src.video_utils as vu

    fake = tmp_path / "backend" / "src"
    fake.mkdir(parents=True)
    tdir = tmp_path / "backend" / "transitions"
    tdir.mkdir()
    (tdir / "bad.mp4").write_bytes(b"<!DOCTYPE html>")
    (tdir / "ok.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")
    monkeypatch.setattr(vu, "__file__", str(fake / "video_utils.py"))
    assert [Path(p).name for p in get_available_transitions()] == ["ok.mp4"]


def test_yunet_model_is_loadable():
    assert isinstance(open_yunet_detector(), YuNetFaceDetector)
