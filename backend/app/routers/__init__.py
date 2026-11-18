"""
Router package initialization.

`folders` was removed: Hearth uses ONE flat global library.
`playback` is imported as a module by main.py (app.include_router(playback.router)).
"""

from .auth import router as auth_router
from .files import router as files_router
from .streaming import router as streaming_router

__all__ = ["auth_router", "files_router", "streaming_router"]