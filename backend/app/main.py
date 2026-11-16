"""
FastAPI main application with Telegram MTProto client lifecycle.
"""
import logging
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from .config import get_settings
from .database import init_db
from .telegram import start_telegram_client, stop_telegram_client
from .routers import files_router, folders_router, streaming_router, auth_router, tv_router, playback

logging.getLogger("pyrogram").setLevel(logging.INFO)
logger = logging.getLogger(__name__)
settings = get_settings()

limiter = Limiter(key_func=get_remote_address)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - start/stop Telegram client and init DB."""
    logger.info("Starting Media Hub Backend...")
    await init_db()
    logger.info("Database initialized")
    
    # 1. Start the Telegram client FIRST
    await start_telegram_client()
    logger.info("Telegram client started")
    
    # 2. NOW we can import the bot safely (tg_client is alive!)
    from .bot import sync_with_channel
    asyncio.create_task(sync_with_channel())
    
    yield
    
    logger.info("Shutting down...")
    await stop_telegram_client()
    logger.info("Telegram client stopped")


app = FastAPI(
    title="Media Hub API",
    description="Private Telegram media streaming",
    version="1.0.0",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "Range"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    # Never wrap the media stream: BaseHTTPMiddleware adds a copy hop per chunk and
    # interferes with cancellation when the browser seeks.
    if request.url.path.startswith("/api/stream/"):
        return await call_next(request)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

# Include routers
app.include_router(auth_router, prefix="/api")
app.include_router(files_router, prefix="/api")
app.include_router(folders_router, prefix="/api")
app.include_router(streaming_router, prefix="/api")
app.include_router(tv_router, prefix="/api")
app.include_router(playback.router, prefix="/api")

@app.get("/health")
async def health():
    from .byte_cache import get_cache_stats
    return {
        "status": "healthy",
        "cache": get_cache_stats()
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=settings.server_host, port=settings.server_port, reload=True)
