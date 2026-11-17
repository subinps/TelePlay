from app.routers.streaming import parse_range_header

SIZE = 1000


def test_no_range_full_200():
    assert parse_range_header(None, SIZE) == (0, 999, 200)


def test_open_ended():
    assert parse_range_header("bytes=0-", SIZE) == (0, 999, 206)


def test_exact_range():
    assert parse_range_header("bytes=100-199", SIZE) == (100, 199, 206)


def test_suffix_range():
    assert parse_range_header("bytes=-500", SIZE) == (500, 999, 206)


def test_suffix_zero_416():
    assert parse_range_header("bytes=-0", SIZE)[2] == 416


def test_start_beyond_eof_416():
    assert parse_range_header("bytes=2000-", SIZE)[2] == 416


def test_clamped_end():
    assert parse_range_header("bytes=900-5000", SIZE) == (900, 999, 206)


def test_malformed_falls_back_to_full():
    assert parse_range_header("bytes=abc", SIZE) == (0, 999, 200)


def test_zero_size_416():
    assert parse_range_header(None, 0)[2] == 416