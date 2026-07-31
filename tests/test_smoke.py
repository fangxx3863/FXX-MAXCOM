def test_smoke_imports() -> None:
    import app
    import core
    import ui

    assert app is not None
    assert core is not None
    assert ui is not None
